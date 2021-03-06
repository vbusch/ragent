/*
 * Copyright 2016 Red Hat Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var util = require("util");
var events = require("events");
var futurejs = require("./future.js");
var myutils = require("./utils.js");

/**
 * A KnownRouter instance represents routers this process knows about
 * but is not directly connected to (or responsible for).
 */
var KnownRouter = function (container_id, listeners) {
    this.container_id = container_id;
    this.listeners = listeners;
};


function address_equivalence(a, b) {
    if (a === undefined) return b === undefined;
    return a.name === b.name && a.multicast === b.multicast && a.store_and_forward === b.store_and_forward;
}

function link_route_equivalence(a, b) {
    if (a === undefined) return b === undefined;
    return a.name === b.name && a.prefix === b.prefix && a.dir === b.dir;
}

/**
 * A ConnectedRouter represents a router this process is connected to
 * and is therefore resonsbile for configuring.
 */
var ConnectedRouter = function (connection) {
    events.EventEmitter.call(this);
    this.connection = connection;
    this.container_id = connection.container_id;
    this.listeners = undefined;
    this.connectors = undefined;
    this.addresses = {};
    this.initial_provisioning_completed = false;

    //management client:
    this.sender = connection.open_sender('$management');
    this.counter = 0;
    this.requests = {};
    connection.open_receiver({source:{dynamic:true}});
    connection.on('receiver_open', this.init.bind(this));
    connection.on('message', this.incoming.bind(this));
    connection.on('disconnected', this.disconnected.bind(this));
    connection.on('connection_close', this.closed.bind(this));

    this.update_types = {
        address: {add: this.define_address_and_autolinks.bind(this), remove: this.delete_address_and_autolinks.bind(this), equivalence: address_equivalence},
        link_route: {add: this.define_link_route.bind(this), remove: this.delete_link_route.bind(this), equivalence: link_route_equivalence}
    };
};

util.inherits(ConnectedRouter, events.EventEmitter);

function remove_current(set) {
    if (this.listeners) {
        this.listeners.forEach(function (l) { delete set[l]; });
    }
}

function has_listener(host_port) {
    return this.listeners && this.listeners.indexOf(host_port) !== -1;
}

ConnectedRouter.prototype.closed = function (context) {
    if (context.connection.error) {
        console.log('ERROR: router closed connection with ' + context.connection.error.description);
    }
    this.connection = undefined;
    this.sender = undefined;
};

ConnectedRouter.prototype.disconnected = function (context) {
    this.connection = undefined;
    this.sender = undefined;
};

ConnectedRouter.prototype.has_connector_to = function (router) {
    return this.connectors && this.connectors.some(has_listener.bind(router));
};

ConnectedRouter.prototype.expects_connector_to = function (router) {
    return router.container_id < this.container_id && router.listeners && router.listeners.length > 0;
};

ConnectedRouter.prototype.is_missing_connector_to = function (router) {
    return this.expects_connector_to(router) && !this.has_connector_to(router);
};

ConnectedRouter.prototype.is_ready_for_connectivity_check = function () {
    return this.initial_provisioning_completed && this.connectors !== undefined;
}

ConnectedRouter.prototype.is_ready_for_address_update = function () {
    return this.addresses !== undefined;
}

ConnectedRouter.prototype.check_connectors = function (routers) {
    var missing = [];
    var stale = myutils.index(this.connectors);
    for (var r in routers) {
        var router = routers[r];
        if (router === this) continue;
        if (this.is_missing_connector_to(router)) {
            missing.push(router.listeners[0]);
        }
        remove_current.call(router, stale);
    }
    stale = Object.keys(stale);
    console.log('checking connectors on router ' + this.container_id + ', missing=' + missing + ', stale=' + stale);


    var num_connectors = 1;
    if (process.env.ROUTER_NUM_CONNECTORS) {
        num_connectors = process.env.ROUTER_NUM_CONNECTORS;
    }
    var do_create = this.forall_connectors.bind(this, num_connectors, this.create_connector.bind(this));
    var do_delete = this.forall_connectors.bind(this, num_connectors, this.delete_connector.bind(this));
    var work = missing.map(do_create).concat(stale.map(do_delete));
    if (work.length) {
        //if made changes, requery when they are complete
        work.reduce(futurejs.and).then(this.on_connectors_updated.bind(this));
        //prevent any updates to connectors until we have re-retrieved
        //them from router after updates:
        this.connectors = undefined;
    }
};

function is_topic(address) {
    return address.multicast === true && address.store_and_forward === true;
}

function to_link_route(direction, address) {
    return {name:address.name + '_' + direction, prefix:address.name, dir:direction};
}

function to_in_link_route(address) {
    return to_link_route('in', address);
}

function to_out_link_route(address) {
    return to_link_route('out', address);
}

function to_link_routes(address_list) {
    var links = address_list.map(to_in_link_route).concat(address_list.map(to_out_link_route));
    return myutils.index(links, by_name);
}

function update(actual, desired, type) {
    var removed = myutils.values(myutils.difference(actual, desired, type.equivalence));
    var added = myutils.values(myutils.difference(desired, actual, type.equivalence));
    return removed.map(type.remove).concat(added.map(type.add));
}

ConnectedRouter.prototype.verify_addresses = function (expected) {
    if (this.addresses === undefined || this.link_routes == undefined) {
        return false;
    }

    for (var i = 0; i < expected.length; i++) {
        var address = expected[i];
        if (address["store_and_forward"] && !address["multicast"]) {
            if (this.addresses[address.name] === undefined) {
                return false;
            }
        }
    }
    return true;
}

ConnectedRouter.prototype.sync_addresses = function (desired) {
    if (this.addresses === undefined || this.link_routes === undefined) {
        console.log('router ' + this.container_id + ' is not ready for address check');
        return;
    }
    var topics = {};
    var others = {};
    myutils.separate(desired, is_topic, topics, others);

    var work = update(this.addresses, others, this.update_types.address);
    work.concat(update(this.link_routes, to_link_routes(myutils.values(topics)), this.update_types.link_route));

    if (work.length) {
        //if made changes, requery when they are complete
        work.reduce(futurejs.and).then(this.on_addresses_updated.bind(this));
        //prevent any updates to addresses until we have re-retrieved
        //them from router after updates:
        this.addresses = undefined;
        this.link_routes = undefined;
    } else {
        if (this.initial_provisioning_completed !== true) {
            this.initial_provisioning_completed = true;
            this.emit('provisioned', this);
        }
    }
};

ConnectedRouter.prototype.init = function (context) {
    this.address = context.receiver.remote.attach.source.address;
    this.emit('ready', this);
};

function created(message) { if (message.statusCode !== 201) return message.statusDescription; };

function deleted(message) { if (message.statusCode !== 204) return message.statusDescription; };

ConnectedRouter.prototype.forall_connectors = function (num_connectors, connector_operation, host_port) {
    var futures = [];
    for (var i = 0; i < num_connectors; i++) {
        var connector_name = host_port + "-" + i;
        futures.push(connector_operation(host_port, connector_name));
    }
    return futures.reduce(futurejs.and)
}

ConnectedRouter.prototype.create_connector = function (host_port, connector_name) {
    var future = futurejs.future(created);
    var parts = host_port.split(':');
    console.log('creating connector ' + connector_name + ' to ' + host_port + ' on router ' + this.container_id);
    this.create_entity('connector', connector_name, {role:'inter-router', addr:parts[0], port:parts[1]}, future.as_callback());
    return future;
};

ConnectedRouter.prototype.delete_connector = function (host_port, connector_name) {
    var future = futurejs.future(deleted);
    console.log('deleting connector to ' + connector_name + ' on router ' + this.container_id);
    this.delete_entity('connector', connector_name, future.as_callback());
    return future;
};

function desired_distribution(address) {
    return address.multicast ? "multicast" : "balanced";
}

function actual_distribution(address) {
    return address.distribution === "multicast";
}

function to_router_address(address) {
    return {prefix:address.name, distribution:desired_distribution(address), waypoint:address.store_and_forward};
}

function from_router_address(address) {
    return {name:address.prefix, multicast:actual_distribution(address), store_and_forward:address.waypoint};
}

ConnectedRouter.prototype.define_address_and_autolinks = function (address) {
    if (address.store_and_forward) {
        return futurejs.and(this.define_address(address),
                            futurejs.and(this.define_autolink(address, "in"),
                                         this.define_autolink(address, "out")));
    } else {
        return this.define_address(address);
    }
}

ConnectedRouter.prototype.define_address = function (address) {
    var future = futurejs.future(created);
    var dist = address.multicast ? "multicast" : "balanced";
    console.log('defining address ' + address.name + ' on router ' + this.container_id);
    this.create_entity('org.apache.qpid.dispatch.router.config.address', address.name, {prefix:address.name, distribution:dist, waypoint:address.store_and_forward}, future.as_callback());
    return future;
};

ConnectedRouter.prototype.delete_address = function (address) {
    var future = futurejs.future(deleted);
    console.log('deleting address ' + address.name + ' on router ' + this.container_id);
    this.delete_entity('org.apache.qpid.dispatch.router.config.address', address.name, future.as_callback());
    return future;
};

ConnectedRouter.prototype.define_autolink = function (address, direction) {
    var future = futurejs.future(created);
    var name = (direction == "in" ? "autoLinkIn" : "autoLinkOut") + address.name;
    console.log('defining autolink for ' + address.name + ' in direction ' + direction + ' on router ' + this.container_id);
    this.create_entity('org.apache.qpid.dispatch.router.config.autoLink', name, {dir:direction, addr:address.name, containerId:address.name}, future.as_callback());
    return future;
}

ConnectedRouter.prototype.delete_autolink = function (address, direction) {
    var future = futurejs.future(created);
    var name = (direction == "in" ? "autoLinkIn" : "autoLinkOut") + address.name;
    console.log('deleting autolink for ' + address.name + ' in direction ' + direction + ' on router ' + this.container_id);
    this.delete_entity('org.apache.qpid.dispatch.router.config.autoLink', name, future.as_callback());
    return future;
}

ConnectedRouter.prototype.delete_address_and_autolinks = function (address) {
    if (address.store_and_forward) {
        return futurejs.and(this.delete_address(address),
                            futurejs.and(this.delete_autolink(address, "in"),
                                         this.delete_autolink(address, "out")));
    } else {
        return this.delete_address(address);
    }
}

ConnectedRouter.prototype.define_link_route = function (route) {
    var future = futurejs.future(created);
    console.log('defining ' + route.dir + ' link route ' + route.prefix + ' on router ' + this.container_id);
    this.create_entity('org.apache.qpid.dispatch.router.config.linkRoute', route.name, {'prefix':route.prefix, dir:route.dir}, future.as_callback());
    return future;
};

ConnectedRouter.prototype.delete_link_route = function (route) {
    var future = futurejs.future(deleted);
    console.log('deleting ' + route.dir + ' link route ' + route.prefix + ' on router ' + this.container_id);
    this.delete_entity('org.apache.qpid.dispatch.router.config.linkRoute', route.name, future.as_callback());
    return future;
};

ConnectedRouter.prototype.retrieve_listeners = function () {
    this.query('listener', {attributeNames:['identity', 'name', 'addr', 'port', 'role']});
};

ConnectedRouter.prototype.retrieve_connectors = function () {
    this.query('connector', {attributeNames:['identity', 'name', 'addr', 'port', 'role']});
};

ConnectedRouter.prototype.retrieve_addresses = function () {
    this.query('org.apache.qpid.dispatch.router.config.address', {attributeNames:[]}, this.on_query_address_response.bind(this));
};

ConnectedRouter.prototype.retrieve_link_routes = function () {
    this.query('org.apache.qpid.dispatch.router.config.linkRoute', {attributeNames:[]}, this.on_query_link_route_response.bind(this));
};

ConnectedRouter.prototype.on_connectors_updated = function (error) {
    if (error) console.log('error on updating connectors for ' + this.container_id + ': ' + error);
    this.retrieve_connectors();
};

ConnectedRouter.prototype.on_addresses_updated = function (error) {
    if (error) console.log('error on updating addresses for ' + this.container_id + ': ' + error);
    else console.log('addresses updated for ' + this.container_id);
    this.retrieve_addresses();
};

ConnectedRouter.prototype.request = function (operation, properties, body, callback) {
    if (this.sender) {
	this.counter++;
	var id = this.counter.toString();
	var req = {reply_to:this.address, correlation_id:id};
        req.application_properties = properties || {};
        req.application_properties.operation = operation;
        req.body = body;
	this.requests[id] = callback || function (response) { console.log('got response: ' + JSON.stringify(req) + ' => ' + JSON.stringify(response)); };
        this.sender.send(req);
    }
};

ConnectedRouter.prototype._get_callback = function (operation, type) {
    var method = this['on_' + operation + '_' + type + '_response'];
    if (method) return method.bind(this);
    else return undefined;
};

ConnectedRouter.prototype.query = function (type, options, callback) {
    this.request('QUERY', {entityType:type}, options || {attributeNames:[]}, callback || this._get_callback('query', type));
};

ConnectedRouter.prototype.create_entity = function (type, name, attributes, callback) {
    this.request('CREATE', {'type':type, 'name':name}, attributes || {}, callback || this._get_callback('create', type));
};

ConnectedRouter.prototype.delete_entity = function (type, name, callback) {
    this.request('DELETE', {'type':type, 'name':name}, {}, callback || this._get_callback('delete', type));
};

function create_record(names, values) {
    var record = {};
    for (var j = 0; j < names.length; j++) {
        record[names[j]] = values[j];
    }
    return record;
}

function extract_records(body) {
    return body.results ? body.results.map(create_record.bind(null, body.attributeNames)) : [];
}

function has_inter_router_role (record) {
    return record.role === 'inter-router';
}

function to_host_port (record) {
    return record.addr + ':' + record.port;
}

ConnectedRouter.prototype.on_query_connector_response = function (message) {
    if (message.application_properties.statusCode == 200) {
        this.connectors = extract_records(message.body).filter(has_inter_router_role).map(to_host_port);
        console.log('retrieved connectors for ' + this.container_id + ': ' + this.connectors);
        this.emit('connectors_updated', this);
    } else {
        console.log('failed to retrieve connectors for ' + this.container_id + ': ' + message.statusDescription);
        this.retrieve_connectors();
    }
};

ConnectedRouter.prototype.on_query_listener_response = function (message) {
    if (message.application_properties.statusCode == 200) {
        this.listeners = extract_records(message.body).filter(has_inter_router_role).map(to_host_port);
        console.log('retrieved listeners for ' + this.container_id + ': ' + this.listeners);
        this.emit('listeners_updated', this);
    } else {
        console.log('failed to retrieve listeners for ' + this.container_id + ': ' + message.statusDescription);
        this.retrieve_listeners();
    }
};

function by_name (o) {
    return o.name;
}

ConnectedRouter.prototype.on_query_address_response = function (message) {
    if (message.application_properties.statusCode == 200) {
        console.log('EXTRACT, results: ' + message.body.results.toString() + ', attributes: ' + message.body.attributeNames.toString());
        var address_records = extract_records(message.body)
        this.addresses = myutils.index(address_records, by_name, from_router_address);
        console.log('retrieved addresses for ' + this.container_id + ': ' + JSON.stringify(this.addresses));
        this.retrieve_link_routes();
    } else {
        console.log('failed to retrieve addresses for ' + this.container_id + ': ' + message.statusDescription);
        this.retrieve_addresses();
    }
};

function not_overridden (linkroute) {
    if (linkroute.name === null) {
        /*name entered in config file currently doesn't make it through*/
        console.log('Ignoring unnamed linkroute: ' + JSON.stringify(linkroute));
    } else {
        return linkroute.name.indexOf('override') !== 0;
    }
}

ConnectedRouter.prototype.on_query_link_route_response = function (message) {
    if (message.application_properties.statusCode == 200) {
        var records = extract_records(message.body);
        console.log('retrieved link routes for ' + this.container_id + ': raw-> ' + JSON.stringify(records));
        this.link_routes = myutils.index(records.filter(not_overridden), by_name);
        //this.link_routes = myutils.index(extract_records(message.body).filter(not_overridden), by_name);
        console.log('retrieved link routes for ' + this.container_id + ': ' + JSON.stringify(this.link_routes));
        this.emit('addresses_updated', this);
    } else {
        console.log('failed to retrieve link routes for ' + this.container_id + ': ' + message.statusDescription);
        this.retrieve_link_routes();
    }
};

ConnectedRouter.prototype.incoming = function (context) {
    //console.log('Got message: ' + JSON.stringify(context.message));
    var message = context.message;
    var handler = this.requests[message.correlation_id];
    if (handler) {
        if (typeof handler === 'function') {
	    delete this.requests[message.correlation_id];
	    handler(message);
        } else {
	    console.log('ERROR: handler not a function: ' + handler + ' [' + JSON.stringify(message) + ']');
        }
    } else {
	console.log('WARNING: unexpected response: ' + message.correlation_id + ' [' + JSON.stringify(message) + ']');
    }
};

module.exports = {
    connected: function (conn) { return new ConnectedRouter(conn); },
    known: function (container_id, listeners) { return new KnownRouter(container_id, listeners); }
};
