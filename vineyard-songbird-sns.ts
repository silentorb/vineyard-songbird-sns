/// <reference path="../vineyard-lawn/lawn.d.ts"/>

import Vineyard = require('vineyard')
var SNS = require('sns-mobile');
import when = require('when')
var pipeline:any = require('when/pipeline')

interface Push_Platform {
  addUser
  sendMessage
}

interface Config {
  path:string
  sns_key_id:string
  sns_access_key:string
  android_arn:string
  ios_arn:string
  region:string
  api_version:string
}

var EMITTED_EVENTS = {
  BROADCAST_START: 'broadcastStart',
  BROADCAST_END: 'broadcastEnd',
  SENT_MESSAGE: 'messageSent',
  DELETED_USER: 'userDeleted',
  FAILED_SEND: 'sendFailed',
  ADDED_USER: 'userAdded',
  ADD_USER_FAILED: 'addUserFailed'
};

class Songbird_SNS extends Vineyard.Bulb {
  platforms = {}

  grow() {
    var path = require('path')
    this.ground.load_schema_from_file(path.resolve(__dirname, 'schema.json'))

    var lawn = this.vineyard.bulbs.lawn
    this.listen(lawn, 'user.login', (user, args)=> this.on_login(user, args))

    var songbird:any = this.vineyard.bulbs.songbird
    if (!songbird)
      throw new Error("Songbird_SNS requires the Songbird bulb.")

    songbird.add_fallback(this)

    var config:Config = this.config

    if (config.android_arn)
      this.create_platform('android', config.android_arn)

    if (config.ios_arn)
      this.create_platform('ios', config.ios_arn)
  }

  create_platform(name:string, arn:string) {
    console.log('creating push platform for ' + name + '.')
    var config:Config = this.config
    this.platforms[name] = new SNS({
      platform: name,
      region: config.region,
      apiVersion: config.api_version,
      accessKeyId: config.sns_key_id,
      secretAccessKey: config.sns_access_key,
      platformApplicationArn: arn
    })
  }

  private get_platform(name:string):Push_Platform {
    var result = this.platforms[name]
    if (!result)
      throw new Error("There is no platform configuration named: " + name + ".")

    return result
  }

  private on_login(user, args):Promise {
    if (args && args.platform && args.device_id)
      return this.register(user, args.platform, args.device_id)

    if (!args)
      console.log("WARNING: Songbird_SNS was not able to get the login arguments.  Possibly using an old version of Lawn.")

    return when.resolve()
  }

  private delete_endpoint(endpoint:string, platform):Promise {
    var def = when.defer()
    platform.deleteUser(endpoint, (error) => {
      if (error) {
        console.log(error)
        def.reject(error)
      }
      else {
        def.resolve()
      }
    })

    return def.promise
  }

  private create_endpoint(user, platform, device_id:string):Promise {
    var def = when.defer()
    var data = JSON.stringify({
      userId: user.id
    })
    platform.addUser(device_id, data, (error, endpoint)=> {
      if (error) {
        console.log(error)
        def.reject(error)
        return
      }

      var sql = "INSERT INTO `push_targets` (`user`, `device_id`, `endpoint`, `platform`, `timestamp`)"
        + "\n VALUES (?, ?, ?, ?, UNIX_TIMESTAMP(NOW()))"
      return this.ground.db.query(sql, [user.id, device_id, endpoint, platform.platform])
        .then(()=> {
          def.resolve()
        })
    })

    return def.promise
  }

  get_user(platform, endpoint) {
    console.log('get_user')
    var def = when.defer()
    platform.getUser(endpoint, (error, response)=> {
      console.log('get_user', error, response)
      if (error) {
        console.log(error)
        def.reject(error)
      }
      else {
        def.resolve(response)
      }
    })

    return def.promise
  }

  register(user, platform_name:string, device_id:string):Promise {
    //console.log('register', platform_name, device_id)
    if (user.username == 'anonymous' || user.name == 'anonymous')
      return when.resolve()

    var platform = this.get_platform(platform_name)

    return this.ground.db.query_single("SELECT * FROM `push_targets` WHERE device_id = ?", [device_id])
      .then((row) => {
        if (row) {
          var update_records = ()=> pipeline([
            ()=> console.log('updating endpoint'),
            ()=> this.delete_endpoint(row.endpoint, platform),
            ()=> this.ground.db.query("DELETE FROM `push_targets` WHERE device_id = ?", [device_id]),
            ()=> this.create_endpoint(user, platform, device_id)
          ])

          if (row.user == user.id) {
            return this.get_user(platform, row.endpoint)
              .then((record)=> {
                console.log('push-record', record)
                //console.log('enabled', record.Attributes)
                return record.Attributes.Enabled == 'false'
                  ? update_records()
                  : when.resolve()
              })
          }
          else {
            return update_records()
          }
        }
        else {
          return this.create_endpoint(user, platform, device_id)
        }
      })
  }

  send(user, message, data, badge):Promise {
    console.log('2pushing message to user ' + user.id + '.', message)
    return this.ground.db.query('SELECT * FROM push_targets WHERE user = ?', [user.id])
      .then((rows)=> {
        if (rows.length == 0)
          return when.resolve([])

        return when.all(rows.map((row)=> this.send_to_endpoint(row.platform, row.endpoint, message, data, badge)))
      })
  }

  private send_to_endpoint(platform_name:string, endpoint:string, message, data, badge) {
    console.log('send_to_endpoint', platform_name)
    var platform = this.get_platform(platform_name)
    var def = when.defer()
    var json

    if (platform_name == 'ios') {
      var aps = {
        alert: message,
        payload: data
      }
      if (badge)
        aps['badge'] = badge

      json = {}
      json[this.config.ios_payload_key] = JSON.stringify({
        aps: aps
      })
    }
    else {
      var gcm = {
        data: {
          message: message
        }
      }
      json = {
        "GCM": JSON.stringify(gcm)
      }
    }

    console.log("sending sns:", json)
    this.publish(platform, endpoint, json, (error, message_id)=> {
      if (error) {
        console.log("sns error: ", error)
        def.reject(error)
      }
      else {
        console.log('message pushed to endpoint ' + endpoint)
        def.resolve(message_id)
      }
    })

    return def.promise
  }

  private publish(platform, endpointArn, message, callback) {
    platform.sns.publish({
      Message: JSON.stringify(message),
      TargetArn: endpointArn,
      MessageStructure: 'json',
    }, function (error, res) {
      if (error) {
        platform.emit(EMITTED_EVENTS.FAILED_SEND, endpointArn, error);
      } else {
        platform.emit(EMITTED_EVENTS.SENT_MESSAGE, endpointArn, res.MessageId);
      }

      return callback(error, ((res && res.MessageId) ? res.MessageId : null));
    });
  }
}

export = Songbird_SNS