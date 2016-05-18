'use strict';
const debug           = require('debug')('network');
const fs              = require('fs');
const path            = require('path');
const EventEmitter    = require('events').EventEmitter;
const Moniker         = require('moniker');
const publicIp        = require('public-ip');
const os              = require('os');
const chalk           = require('chalk');
const fmt             = require('fmt');
const pkg             = require('../package.json');
const defaults        = require('./constants.js');
const FilesManagement = require('./files/file_manager.js');
const TaskManager     = require('./tasks_manager/task_manager.js');
const
const Tools           = require('./lib/tools.js');
const LoadBalancer    = require('./load-balancer.js');
const API             = require('./api.js');
const Wait            = require('./lib/wait.js');
const
const Interplanetary  = require('./network/interplanetary.js');
const InternalIp      = require('./network/internal-ip.js');
const SocketPool      = require('./network/socket-pool.js');

/**
 * Main entry point of GridControl
 * once object instancied, call .start()
 * @constructor
 * @this {GridControl}
 * @param opts                               {object} options
 * @param opts.peer_name                     {string} host name
 * @param opts.namespace                     {string} grid name for discovery
 * @param opts.peer_api_port                 {integer} API port (then task p+1++)
 * @param opts.file_manager                  {object} default location of sync data
 * @param opts.file_manager.dest_file        {string} default location of sync data
 * @param opts.file_manager.dest_folder      {string} default location of sync data
 * @param opts.file_manager.is_file_master   {string} default location of sync data
 * @param opts.file_manager.has_file_to_sync {string} default location of sync data
 * @param opts.file_manager.tmp_folder       {string} default location of folder uncomp
 * @param opts.task_manager                  {object} default location of sync data
 * @param opts.task_meta                     {object} default location of sync data
 * @param opts.task_meta.instances           {integer} default location of sync data
 * @param opts.task_meta.json_conf           {object} default location of sync data
 * @param opts.task_meta.task_folder         {string} default location of sync data
 * @param opts.task_meta.env                 {object} default location of sync data
 *
 * @fires GridControl#ready
 * @fires GridControl#ip:ready
 * @fires GridControl#discovery:ready
 * @fires GridControl#api:ready
 * @fires GridControl#files:synchronized
 * @fires GridControl#peer:synchronize
 * @fires GridControl#new:peer
 */
var GridControl = function(opts) {
  if (!(this instanceof GridControl))
    return new GridControl(opts);

  var that = this;

  this.peer_name        = opts.peer_name || Moniker.choose();
  this.namespace        = process.env.GRID || opts.namespace || 'pm2:fs';
  this.private_ip       = InternalIp.v4();
  this.peer_api_port    = opts.peer_api_port  || 10000;
  this.processing_tasks = [];
  this.SocketPool       = new SocketPool();

  /**
   * File manager initialization
   */
  var file_manager_opts = {
    dest_file   : defaults.TMP_FILE,
    dest_folder : defaults.TMP_FOLDER
  };

  if (opts.file_manager)
    file_manager_opts = opts.file_manager;

  this.file_manager = new FilesManagement(file_manager_opts);

  /**
   * Task manager initialization
   */
  var task_manager_opts = {
    port_offset : that.peer_api_port + 1
  };

  if (opts.task_manager && opts.task_manager.task_meta) {
    task_manager_opts.task_meta = opts.task_manager.task_meta;
  }

  this.task_manager = new TaskManager(task_manager_opts);

  /**
   * Load balancer initialization
   */
  this.load_balancer = new LoadBalancer({
    local_loop  : true,
    socket_pool : this.SocketPool
  });

  /**
   * API initialization
   */
  this.api = new API({
    load_balancer: that.load_balancer,
    task_manager : that.task_manager,
    file_manager : that.file_manager,
    net_manager  : this,
    port         : that.peer_api_port
  });
};

GridControl.prototype.__proto__ = EventEmitter.prototype;

/**
 * Stop everything (api, discovery, socket pool, task manager, file manager)
 * @public
 */
GridControl.prototype.close = function(cb) {
  debug(chalk.red('[SHUTDOWN]') + '[%s] Closing whole server', this.peer_name);
  this.api.close();
  this.Interplanetary.close();
  this.SocketPool.close();
  this.task_manager.terminate();
  this.file_manager.clear(cb);
};

/**
 * Serialize whole Grid control for later restore
 * Just pass back this objet to Gridcontrol constructor to rebuild
 */
GridControl.prototype.serialize = function() {
  return {
    peer_name    : this.peer_name,
    namespace    : this.namespace,
    peer_api_port: this.peer_api_port,
    file_manager : this.file_manager.serialize(),
    task_manager : this.task_manager.serialize()
  };
};

/**
 * Start Grid control
 */
GridControl.prototype.start = function() {

  // Wait until every element has been emitted
  // passer bind(this) plutot ?
  // il se passe quoi si startDiscovery fail à l'init et que l'event est pas send?
  let promise = Wait(this, [
    'ip:ready',
    'discovery:ready',
    'api:ready'
  ])
  .then(() => {
    this.emit('ready');

    /**
     * Force re discovery if no grid has been detected
     */
    setInterval(() => {
      if (this.getRouters().length == 0) {
        debug('Retrying discovery');
        this.Interplanetary.close();
        this.startDiscovery(this.namespace);
      }
    }, 10000);

    if (process.env.NODE_ENV != 'test')
      Tools.writeConf(this.serialize());

    // Form
    fmt.title('Peer ready');
    fmt.field('Name', this.peer_name);
    fmt.field('Public IP', this.public_ip);
    fmt.field('Private IP', this.private_ip);
    fmt.field('Local API port', this.peer_api_port);
    fmt.field('Network port', this.network_port);
    fmt.field('DSS port', defaults.DSS_FS_PORT);
    fmt.field('Joined Namespace', this.namespace);
    fmt.field('Created at', new Date());
    fmt.sep();
    return Promise.resolve()
  });

  publicIp.v4().then(ip => {
    this.public_ip = ip;
    this.emit('ip:ready');

    this.startDiscovery(this.namespace, err => {
      if (err) console.error(err);
      this.emit('discovery:ready');
    });
  });

  this.api.start()
  .then(() => {
    console.log('api ready');
    this.emit('api:ready');
  })
  // .catch((err) => {})
  
  return promise
};

/**
 * Start network discovery
 * @param ns {string} namespace for discovery
 * @public
 */
GridControl.prototype.startDiscovery = function(ns, cb) {
  var that = this;

  this.namespace = ns;

  var key = new Buffer(this.namespace + ':square-node:unik');

  this.Interplanetary = Interplanetary({
    dht : {
      interval : 15000
    }
  });

  this.Interplanetary.listen(0);
  this.Interplanetary.join(key.toString('hex'));

  this.Interplanetary.on('error', function(e) {
    console.error('Interplanetary got error');
    console.error(e.message);
    return cb(e);
  });

  this.Interplanetary.on('listening', function() {
    that.network_port = that.Interplanetary._tcp.address().port;
    return cb ? cb() : false;
  });

  this.Interplanetary.on('connection', this.onNewPeer.bind(this));
};

/**
 * Stop discovery
 * @param cb {callback
 * @public
 */
GridControl.prototype.stopDiscovery = function(cb) {
  this.Interplanetary.close();
};

/**
 * Handle peer when connected
 * @param sock {object} socket object
 * @public
 */
GridControl.prototype.onNewPeer = function(sock, remoteId) {
  var that   = this;
  var router = this.SocketPool.add(sock);

  that.emit('new:peer', sock);

  router.send('identity', that.getLocalIdentity());

  /**
   * When a new peer connect and req is received to master && is synced
   * tell the new peer to synchronize with the current peer
   */
  if (that.file_manager.isFileMaster() &&
      that.file_manager.hasFileToSync()) {
    setTimeout(function() {
      that.askPeerToSync(router);
    }, 1500);
  }

  router.on('clear', function(data) {
    that.file_manager.clear();
  });

  router.on('trigger', function(packet, cb) {
    var task_id    = packet.task_id;
    var task_data  = packet.data;
    var task_opts  = packet.opts;

    if (process.env.NODE_ENV == 'test')
      return cb();

    debug('Received a trigger action: %s', task_id);

    that.task_manager.triggerTask({
      task_id  : task_id,
      task_data: task_data,
      task_opts: task_opts
    }, function(err, res) {
      return cb(err, res);
    });
  });

  /**
   * Received by master once the peer has been synchronized
   */
  router.on('sync:done', function(data) {
    if (data.synced_md5 == that.file_manager.getCurrentMD5()) {
      debug('Peer [%s] successfully synchronized with up-to-date sync file',
            router.identity.name);
      router.identity.synchronized = true;
    }
  });

  /**
   * Task to synchronize this node
   */
  router.on('sync', function(data, file) {
    console.log('[%s] Incoming sync req from priv_ip=%s pub_ip=%s for MD5 [%s]',
                that.peer_name,
                data.private_ip,
                data.public_ip,
                data.curr_md5);

    // Write received file to destination file
    that.file_manager.synchronize(data, file, function(err, meta) {
      if (err)
        return console.error('Error while synchronizing file', err);

      // Set unpacked file path as base folder
      data.meta.base_folder = meta.dest_folder;

      // Set task meta (env, task folder)
      that.task_manager.setTaskMeta(data.meta);

      that.emit('files:synchronized', {
        file : that.file_manager.getFilePath()
      });

      if (process.env.NODE_ENV == 'test') {
        return that.SocketPool.broadcast('sync:done', {
          synced_md5 : data.curr_md5
        });
      }

      that.task_manager.initTaskGroup(data.meta, function() {
        // Notify master that current peer
        // has sync with this MD5 (to be sure is synced on right
        // files project)
        that.SocketPool.broadcast('sync:done', {
          synced_md5 : data.curr_md5
        });
      });
    });
  });
};

/**
 * Return peers connected
 * @public
 */
GridControl.prototype.getRouters = function() {
  return this.SocketPool.getRouters();
};

/**
 * Get local identity
 * @public
 */
GridControl.prototype.getLocalIdentity = function() {
  var that = this;

  return {
    public_ip    : that.public_ip,
    private_ip   : that.private_ip,
    api_port     : that.peer_api_port,
    name         : that.peer_name,
    hostname     : os.hostname(),
    platform     : os.platform(),
    ns           : that.namespace,
    files_master : this.file_manager.isFileMaster(),
    user         : process.env.USER,
    grid_version : pkg.version,
    uptime       : process.uptime()
  };
};

/**
 * Send command to all peers to synchronize
 * @public
 */
GridControl.prototype.askAllPeersToSync = function() {
  var that = this;

  this.SocketPool.getRouters().forEach(function(router) {
    router.identity.synchronized = false;
    that.askPeerToSync(router);
  });
};

/**
 * Send peer to synchronize
 * it sends the file buffer and meta on the same command
 * (see that.file_manager.current_file_buff argument)
 * @param router {object} router object
 * @public
 */
GridControl.prototype.askPeerToSync = function(router) {
  var that = this;

  that.emit('peer:synchronize');

  debug('Asking %s[%s] to sync', router.identity.public_ip, router.identity.name);
  router.send('sync', {
    public_ip  : that.public_ip,
    private_ip : that.private_ip,
    meta       : that.task_manager.getTaskMeta(),
    curr_md5   : that.file_manager.getCurrentMD5()
  }, that.file_manager.current_file_buff);
};

module.exports = GridControl;
