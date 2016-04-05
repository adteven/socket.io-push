/**
 * Module dependencies.
 */

var uid2 = require('uid2');
var redis = require('redis').createClient;
var msgpack = require('msgpack-js');
var Adapter = require('socket.io-adapter');
var logger = require('../log/index.js')('RedisAdapter');

var async = require('async');

/**
 * Module exports.
 */

module.exports = adapter;

/**
 * Returns a redis Adapter class.
 *
 * @param {String} optional, redis uri
 * @return {RedisAdapter} adapter
 * @api public
 */

function adapter(uri, opts, stats) {
    opts = opts || {};

    // handle options only
    if ('object' == typeof uri) {
        opts = uri;
        uri = null;
    }

    // handle uri string
    if (uri) {
        uri = uri.split(':');
        opts.host = uri[0];
        opts.port = uri[1];
    }

    // opts
    var host = opts.host || '127.0.0.1';
    var port = Number(opts.port || 6379);
    var pub = opts.pubClient;
    var sub = opts.subClient;
    var prefix = opts.key || 'socket.io';

    // init clients if needed
    if (!pub) pub = redis(port, host);
    if (!sub) sub = redis(port, host, {return_buffers: true});

    // this server's key
    var uid = uid2(6);

    /**
     * Adapter constructor.
     *
     * @param {String} namespace name
     * @api public
     */

    function Redis(nsp) {
        Adapter.call(this, nsp);

        this.uid = uid;
        this.pubClient = pub;
        this.subClient = sub;

        var self = this;
        sub.subscribe(prefix + '#' + nsp.name + '#', function (err) {
            if (err) self.emit('error', err);
        });
        sub.on('message', this.onmessage.bind(this));
    }

    /**
     * Inherits from `Adapter`.
     */

    Redis.prototype.__proto__ = Adapter.prototype;

    /**
     * Called with a subscription message
     *
     * @api private
     */

    Redis.prototype.onmessage = function (channel, msg) {
        logger.log("info", 'channel %s', channel.toString().startsWith(prefix));
        if (stats && stats.shouldDrop()) {
            return;
        }
        var args = msgpack.decode(msg);
        var packet;

        if (uid == args.shift()) return  logger.log("info", 'ignore same uid');

        packet = args[0];

        if (packet && packet.nsp === undefined) {
            packet.nsp = '/';
        }

        if (!packet || packet.nsp != this.nsp.name) {
            return logger.log("info", 'ignore different namespace');
        }

        args.push(true);

        this.broadcast.apply(this, args);
    };

    /**
     * Broadcasts a packet.
     *
     * @param {Object} packet to emit
     * @param {Object} options
     * @param {Boolean} whether the packet came from another node
     * @api public
     */

    Redis.prototype.broadcast = function (packet, opts, remote) {
        Adapter.prototype.broadcast.call(this, packet, opts);
        if (!remote) {
            var chn = prefix + '#' + packet.nsp + '#';
            var msg = msgpack.encode([uid, packet, opts]);
            if (opts.rooms) {
                opts.rooms.forEach(function (room) {
                    var chnRoom = chn + room + '#';
                    pub.publish(chnRoom, msg);
                });
            } else {
                pub.publish(chn, msg);
            }
        }
    };

    /**
     * Subscribe client to room messages.
     *
     * @param {String} client id
     * @param {String} room
     * @param {Function} callback (optional)
     * @api public
     */

    Redis.prototype.add = function (id, room, fn) {
        var self = this;
        logger.log("info", 'adding %s to %s', id, room);
        var needRedisSub = this.rooms.hasOwnProperty(room) && this.rooms[room]
        Adapter.prototype.add.call(this, id, room);
        var channel = prefix + '#' + this.nsp.name + '#' + room + '#';
        if (id == room) {
            logger.log("info", "skip add to id %s", room);
            return;
        }
        if (needRedisSub) {
            loggerlog("info", "skip re-subscribe to room %s", room);
            return;
        }
        sub.subscribe(channel, function (err) {
            if (err) {
                logger.log("info", 'subscribe error %s', channel);
                self.emit('error', err);
                if (fn) fn(err);
                return;
            }
            if (fn) fn(null);
        });
    };

    /**
     * Unsubscribe client from room messages.
     *
     * @param {String} session id
     * @param {String} room id
     * @param {Function} callback (optional)
     * @api public
     */

    Redis.prototype.del = function (id, room, fn) {
        logger.log("info", 'removing %s from %s', id, room);
        var self = this;
        var hasRoom = this.rooms.hasOwnProperty(room);
        Adapter.prototype.del.call(this, id, room);

        if (hasRoom && !this.rooms[room]) {

            var channel = prefix + '#' + this.nsp.name + '#' + room + '#';
            logger.log("info", 'unsubscribing %s', channel);
            sub.unsubscribe(channel, function (err) {
                if (err) {
                    self.emit('error', err);
                    if (fn) fn(err);
                    return;
                }
                if (fn) fn(null);
            });
        } else {
            if (fn) process.nextTick(fn.bind(null, null));
        }
    };

    /**
     * Unsubscribe client completely.
     *
     * @param {String} client id
     * @param {Function} callback (optional)
     * @api public
     */

    Redis.prototype.delAll = function (id, fn) {
        logger.log("info", 'removing %s from all rooms', id);
        var self = this;
        var rooms = this.sids[id];

        if (!rooms) {
            if (fn) process.nextTick(fn.bind(null, null));
            return;
        }

        async.forEach(Object.keys(rooms), function (room, next) {
            self.del(id, room, next);
        }, function (err) {
            if (err) {
                self.emit('error', err);
                if (fn) fn(err);
                return;
            }
            delete self.sids[id];
            if (fn) fn(null);
        });
    };

    Redis.uid = uid;
    Redis.pubClient = pub;
    Redis.subClient = sub;
    Redis.prefix = prefix;

    return Redis;

}
