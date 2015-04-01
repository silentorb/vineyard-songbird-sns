var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var Vineyard = require('vineyard');
var SNS = require('sns-mobile');
var when = require('when');
var pipeline = require('when/pipeline');

var EMITTED_EVENTS = {
    BROADCAST_START: 'broadcastStart',
    BROADCAST_END: 'broadcastEnd',
    SENT_MESSAGE: 'messageSent',
    DELETED_USER: 'userDeleted',
    FAILED_SEND: 'sendFailed',
    ADDED_USER: 'userAdded',
    ADD_USER_FAILED: 'addUserFailed'
};

var Songbird_SNS = (function (_super) {
    __extends(Songbird_SNS, _super);
    function Songbird_SNS() {
        _super.apply(this, arguments);
        this.platforms = {};
    }
    Songbird_SNS.prototype.grow = function () {
        var _this = this;
        var path = require('path');
        this.ground.load_schema_from_file(path.resolve(__dirname, 'schema.json'));

        var lawn = this.vineyard.bulbs.lawn;
        this.listen(lawn, 'user.login', function (user, args) {
            return _this.on_login(user, args);
        });

        var songbird = this.vineyard.bulbs.songbird;
        if (!songbird)
            throw new Error("Songbird_SNS requires the Songbird bulb.");

        songbird.add_fallback(this);

        var config = this.config;

        if (config.android_arn)
            this.create_platform('android', config.android_arn);

        if (config.ios_arn)
            this.create_platform('ios', config.ios_arn);
    };

    Songbird_SNS.prototype.create_platform = function (name, arn) {
        console.log('creating push platform for ' + name + '.');
        var config = this.config;
        this.platforms[name] = new SNS({
            platform: name,
            region: config.region,
            apiVersion: config.api_version,
            accessKeyId: config.sns_key_id,
            secretAccessKey: config.sns_access_key,
            platformApplicationArn: arn
        });
    };

    Songbird_SNS.prototype.get_platform = function (name) {
        var result = this.platforms[name];
        if (!result)
            throw new Error("There is no platform configuration named: " + name + ".");

        return result;
    };

    Songbird_SNS.prototype.on_login = function (user, args) {
        if (args && args.platform && args.device_id)
            return this.register(user, args.platform, args.device_id);

        if (!args)
            console.log("WARNING: Songbird_SNS was not able to get the login arguments.  Possibly using an old version of Lawn.");

        return when.resolve();
    };

    Songbird_SNS.prototype.delete_endpoint = function (endpoint, platform) {
        var def = when.defer();
        console.log('deleting endpoint', endpoint);
        platform.deleteUser(endpoint, function (error) {
            if (error) {
                console.error(error);
                def.reject(error);
            } else {
                console.log('endpoint deleted', arguments);
                def.resolve();
            }
        });

        return def.promise;
    };

    Songbird_SNS.prototype.create_endpoint = function (user, platform, device_id) {
        var _this = this;
        console.log('creating endpoint', device_id);
        var def = when.defer();
        var data = JSON.stringify({
            userId: user.id
        });
        platform.addUser(device_id, data, function (error, endpoint) {
            if (error) {
                console.error('Error creating SNS endpoint', error);
                def.reject(error);
                return;
            }

            var sql = "INSERT INTO `push_targets` (`user`, `device_id`, `endpoint`, `platform`, `timestamp`)" + "\n VALUES (?, ?, ?, ?, UNIX_TIMESTAMP(NOW()))";
            return _this.ground.db.query(sql, [user.id, device_id, endpoint, platform.platform]).then(function () {
                def.resolve();
            });
        });

        return def.promise;
    };

    Songbird_SNS.prototype.get_user = function (platform, endpoint) {
        console.log('get_user');
        var def = when.defer();
        platform.getUser(endpoint, function (error, response) {
            console.log('get_user', error, response);
            if (error) {
                console.log(error);
                def.reject(error);
            } else {
                def.resolve(response);
            }
        });

        return def.promise;
    };

    Songbird_SNS.prototype.register = function (user, platform_name, device_id) {
        var _this = this;
        if (user.username == 'anonymous' || user.name == 'anonymous')
            return when.resolve();

        var platform = this.get_platform(platform_name);

        return this.ground.db.query_single("SELECT * FROM `push_targets` WHERE device_id = ?", [device_id]).then(function (row) {
            if (row) {
                var update_records = function () {
                    return pipeline([
                        function () {
                            return console.log('updating endpoint');
                        },
                        function () {
                            return _this.delete_endpoint(row.endpoint, platform);
                        },
                        function () {
                            return _this.ground.db.query("DELETE FROM `push_targets` WHERE device_id = ?", [device_id]);
                        },
                        function () {
                            return _this.create_endpoint(user, platform, device_id);
                        }
                    ]);
                };

                if (row.user == user.id) {
                    return _this.get_user(platform, row.endpoint).then(function (record) {
                        console.log('push-record', record);

                        return record.Attributes.Enabled == 'false' ? update_records() : when.resolve();
                    });
                } else {
                    return update_records();
                }
            } else {
                return _this.create_endpoint(user, platform, device_id);
            }
        }).catch(function (error) {
            return console.error('SNS register error:', error);
        });
    };

    Songbird_SNS.prototype.send = function (user, message, data, badge) {
        var _this = this;
        console.log('2pushing message to user ' + user.id + '.', message);
        return this.ground.db.query('SELECT * FROM push_targets WHERE user = ?', [user.id]).then(function (rows) {
            if (rows.length == 0)
                return when.resolve([]);

            return when.all(rows.map(function (row) {
                return _this.send_to_endpoint(row.platform, row.endpoint, message, data, badge);
            }));
        }).catch(function (error) {
            return console.error('SNS send error:', error);
        });
    };

    Songbird_SNS.prototype.send_to_endpoint = function (platform_name, endpoint, message, data, badge) {
        console.log('send_to_endpoint', platform_name);
        var platform = this.get_platform(platform_name);
        var def = when.defer();
        var json;

        if (platform_name == 'ios') {
            var aps = {
                alert: message,
                payload: data
            };
            if (badge)
                aps['badge'] = badge;

            json = {};
            json[this.config.ios_payload_key] = JSON.stringify({
                aps: aps
            });
        } else {
            var gcm = {
                data: {
                    message: message
                }
            };
            json = {
                "GCM": JSON.stringify(gcm)
            };
        }

        console.log("sending sns:", json);
        this.publish(platform, endpoint, json, function (error, message_id) {
            if (error) {
                console.error("sns error: ", error);
                def.reject(error);
            } else {
                console.log('message pushed to endpoint ' + endpoint);
                def.resolve(message_id);
            }
        });

        return def.promise;
    };

    Songbird_SNS.prototype.publish = function (platform, endpointArn, message, callback) {
        platform.sns.publish({
            Message: JSON.stringify(message),
            TargetArn: endpointArn,
            MessageStructure: 'json'
        }, function (error, res) {
            if (error) {
                platform.emit(EMITTED_EVENTS.FAILED_SEND, endpointArn, error);
            } else {
                platform.emit(EMITTED_EVENTS.SENT_MESSAGE, endpointArn, res.MessageId);
            }

            return callback(error, ((res && res.MessageId) ? res.MessageId : null));
        });
    };
    return Songbird_SNS;
})(Vineyard.Bulb);

module.exports = Songbird_SNS;
//# sourceMappingURL=vineyard-songbird-sns.js.map
