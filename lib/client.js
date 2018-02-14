/* global require:false, fetch:false, Request:false */

'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

var msgr = require('msgr');
var shortid = require('shortid');
var defer = require('mini-defer');
var register = require('sw-register');
var serialiseRequest = require('serialise-request');
var serialiseResponse = require('serialise-response');

var ready = defer();

var syncs = [];
var channel = null;
var hasStartedInit = false;
var hasBackgroundSyncSupport = true;

var syncUtil = {
  _base: {
    id: null,
    name: null,
    createdOn: null,
    syncedOn: null,
    request: null,
    response: null,
    cancelled: false
  },

  _create: function _create() {
    var obj = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    return _extends({}, syncUtil._base, obj, defer());
  },
  createFromUserOptions: function createFromUserOptions(obj) {
    return syncUtil._create({
      id: obj.name || shortid.generate(),
      name: obj.name,
      createdOn: Date.now(),
      request: obj.request
    });
  },
  hydrate: function hydrate(obj) {
    var sync = syncUtil._create(obj);
    if (sync.response) {
      sync.response = serialiseResponse.deserialise(sync.response);
      sync.resolve();
    }
    return sync;
  },
  makePublicApi: function makePublicApi(sync) {
    return Object.assign(sync.promise, {
      name: sync.name,
      id: sync.id,
      createdOn: sync.createdOn,
      syncedOn: sync.syncedOn,
      cancel: function cancel() {
        return !sync.cancelled && !sync.response ? (sync.cancelled = true, channel.send('CANCEL_SYNC', sync.id)) : Promise.reject(new Error('already cancelled or complete'));
      }
    });
  }
};

/**
 * Start a channel with the worker. Wrapped so we can delay
 * execution until we know we have an activated worker.
 * @param {Object} worker
 * @returns {Object}
 */
var openCommsChannel = function openCommsChannel(worker) {
  return msgr.client(worker, {
    SYNC_RESULT: function SYNC_RESULT(_ref) {
      var id = _ref.id,
          syncedOn = _ref.syncedOn,
          response = _ref.response;

      var sync = syncs.find(function (s) {
        return s.id === id;
      });
      if (sync) {
        var realResponse = serialiseResponse.deserialise(response);
        sync.resolve(realResponse);
        if (sync.name) {
          sync.response = realResponse;
          sync.syncedOn = syncedOn;
        }
      }
    }
  });
};

// ---
// Public
// ---

/**
 * Create a 'sync' operation.
 * @param {String|Request} [name]
 * @param {Object|String|Request} request
 * @param {Object} [options]
 * @returns {Promise}
 */
var _fetchSync = function fetchSync(name, request, options) {
  var _arguments = arguments;

  if (!hasStartedInit) {
    throw new Error('initialise first with fetchSync.init()');
  }

  var isRequestOptionsCall = function isRequestOptionsCall() {
    return _arguments.length === 2 && (typeof _arguments[0] === 'string' || _arguments[0] instanceof Request) && _typeof(_arguments[1]) === 'object' && !(_arguments[1] instanceof Request);
  };

  if (arguments.length === 1) {
    request = name;
    name = null;
  } else if (isRequestOptionsCall()) {
    options = request;
    request = name;
    name = null;
  }

  if (typeof request !== 'string' && !(request instanceof Request)) {
    throw new Error('expecting request to be a string or Request');
  } else if (options && (typeof options === 'undefined' ? 'undefined' : _typeof(options)) !== 'object') {
    throw new Error('expecting options to be an object');
  }

  if (!hasBackgroundSyncSupport) {
    return fetch(request, options);
  }

  var sync = syncs.find(function (s) {
    return s.id === name;
  });

  if (sync) {
    var err = new Error('sync operation already exists with name \'' + name + '\'');
    return Promise.reject(err);
  }

  sync = syncUtil.createFromUserOptions({ name: name, request: request, options: options });

  syncs.push(sync);

  ready.promise.then(function () {
    return serialiseRequest(new Request(request, options));
  }).then(function (request) {
    sync.request = request;
  }).then(function () {
    return channel.send('REGISTER_SYNC', sync);
  });

  return syncUtil.makePublicApi(sync);
};

exports.default = _fetchSync;

/**
 * Initialise fetchSync.
 * @param {Object} options
 * @returns {Promise}
*/

_fetchSync.init = function fetchSync_init() {
  var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : null;

  if (hasStartedInit) {
    throw new Error('fetchSync.init() called multiple times');
  }

  hasStartedInit = true;

  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    hasBackgroundSyncSupport = false;
    return Promise.reject(new Error('environment not supported'));
  }

  return register(options).then(openCommsChannel).then(function (c) {
    channel = c;
  }).then(function () {
    return channel.send('GET_SYNCS');
  }).then(function (data) {
    var _syncs;

    return (_syncs = syncs).push.apply(_syncs, _toConsumableArray((data || []).map(syncUtil.hydrate)));
  }).then(function () {
    ready.resolve();
  });
};

/**
 * Get a sync.
 * @param {String} name
 * @returns {Promise}
 */
_fetchSync.get = waitForReady(function fetchSync_get(name) {
  var sync = syncs.find(function (s) {
    return s.name === name;
  });
  return sync ? syncUtil.makePublicApi(sync) : Promise.reject(new Error('not found'));
});

/**
 * Get all syncs.
 * @returns {Array}
 */
_fetchSync.getAll = waitForReady(function fetchSync_getAll() {
  return syncs.map(syncUtil.makePublicApi);
});

/**
 * Cancel a sync.
 * @param {Object|String} sync
 * @returns {Promise}
 */
_fetchSync.cancel = waitForReady(function fetchSync_cancel(name) {
  var sync = syncs.find(function (s) {
    return s.name === name;
  });
  return sync ? syncUtil.makePublicApi(sync).cancel() : Promise.reject(new Error('not found'));
});

/**
 * Cancel all syncs.
 * @returns {Promise}
 */
_fetchSync.cancelAll = waitForReady(function fetchSync_cancelAll() {
  return channel.send('CANCEL_ALL_SYNCS').then(function () {
    syncs = [];
  });
});

/**
 * Wrap a function to wait for the application to be initialised
 * (comms channel with service worker is open) before executing.
 * @param {Function} method
 * @returns {Function}
 */
function waitForReady(method) {
  return function fetchSync_readyWrapper() {
    for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    if (hasStartedInit) return ready.promise.then(function () {
      return method.apply(undefined, args);
    });
    throw new Error('initialise first with fetchSync.init()');
  };
}
module.exports = exports['default'];