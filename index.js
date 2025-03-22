/**
 * Homebridge Red Alert Plugin
 * A plugin for monitoring Israel's Red Alert system and sending notifications to Chromecast devices using chromecast-api
 */

const WebSocket = require('ws');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const ChromecastAPI = require('chromecast-api'); // NEW: using chromecast-api

let Service, Characteristic;

class RedAlertPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // Plugin configuration
    this.name = config.name || 'Red Alert';
    this.selectedCities = config.cities || [];
    this.alertSoundPath = config.alertSoundPath || 'sounds/alert.mp3';
    this.testSoundPath = config.testSoundPath || 'sounds/test.mp3';
    this.alertVideoPath = config.alertVideoPath || 'videos/alert.mp4';
    this.testVideoPath = config.testVideoPath || 'videos/test.mp4';
    this.chromecastVolume = config.chromecastVolume || 30; // Not used directly; chromecast-api does not expose volume in our example
    this.useChromecast = config.useChromecast !== false;
    this.chromecastTimeout = config.chromecastTimeout || 30; // seconds
    this.wsUrl = config.wsUrl || 'ws://ws.cumta.morhaviv.com:25565/ws';
    this.reconnectInterval = config.reconnectInterval || 5000; // ms
    this.serverPort = config.serverPort || 8095;
    this.baseUrl = config.baseUrl || `http://${this.getIpAddress()}:${this.serverPort}`;

    this.isAlertActive = false;
    this.alertActiveCities = [];
    this.wsClient = null;
    this.reconnectTimer = null;

    // Setup media server
    this.setupMediaServer();

    // Initialize Chromecast discovery using chromecast-api
    if (this.useChromecast) {
      this.chromecastClient = new ChromecastAPI();
      this.chromecastClient.on('device', (device) => {
        this.log.info(`Found Chromecast: ${device.friendlyName} at ${device.host}`);
      });
    }

    // Initialize WebSocket on launch
    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.setupWebSocket();
        this.copyDefaultMediaFiles();
      });
    }

    // HomeKit services
    this.service = new Service.ContactSensor(this.name);
    this.testSwitchService = new Service.Switch(this.name + ' Test', 'test');
    this.testSwitchService
      .getCharacteristic(Characteristic.On)
      .on('set', this.handleTestSwitch.bind(this));
  }

  getServices() {
    const informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Homebridge')
      .setCharacteristic(Characteristic.Model, 'Red Alert')
      .setCharacteristic(Characteristic.SerialNumber, '1.0.0');

    this.service
      .getCharacteristic(Characteristic.ContactSensorState)
      .on('get', this.getAlertState.bind(this));

    return [informationService, this.service, this.testSwitchService];
  }

  getAlertState(callback) {
    callback(null, this.isAlertActive ?
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
      Characteristic.ContactSensorState.CONTACT_DETECTED);
  }

  handleTestSwitch(on, callback) {
    if (on) {
      this.log.info('Running alert test');
      this.triggerTest();
      setTimeout(() => {
        this.testSwitchService.updateCharacteristic(Characteristic.On, false);
      }, 2000);
    }
    callback(null);
  }

  triggerTest() {
    this.isAlertActive = true;
    this.alertActiveCities = this.selectedCities.length > 0 ? [this.selectedCities[0]] : ['Test'];
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    if (this.useChromecast) {
      this.playChromecastMedia(true);
    }

    setTimeout(() => {
      this.isAlertActive = false;
      this.alertActiveCities = [];
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }, 10000);
  }

  setupWebSocket() {
    if (this.wsClient) this.wsClient.terminate();

    this.log.info(`Connecting to WebSocket: ${this.wsUrl}`);
    this.wsClient = new WebSocket(this.wsUrl);

    this.wsClient.on('open', () => {
      this.log.info('WebSocket connected');
      this.log.info('Selected Cities: ' + this.selectedCities)
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.wsClient.on('message', (data) => {
      try {
        this.handleAlertMessage(data.toString());
      } catch (error) {
        this.log.error(`Error processing WebSocket message: ${error}`);
      }
    });

    this.wsClient.on('error', (error) => {
      this.log.error(`WebSocket error: ${error}`);
      this.scheduleReconnect();
    });

    this.wsClient.on('close', () => {
      this.log.info('WebSocket connection closed');
      this.scheduleReconnect();
    });

    const interval = setInterval(() => {
      if (this.wsClient.readyState === WebSocket.OPEN) {
        this.wsClient.ping();
      } else {
        clearInterval(interval);
      }
    }, 30000);
  }

  scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.log.info(`Scheduling WebSocket reconnect in ${this.reconnectInterval / 1000} seconds`);
      this.reconnectTimer = setTimeout(() => {
        this.setupWebSocket();
      }, this.reconnectInterval);
    }
  }

  handleAlertMessage(message) {
    let alert;
    try {
      alert = JSON.parse(message);
    } catch (error) {
      this.log.error(`Failed to parse alert message: ${error}`);
      return;
    }

    if (!alert || !alert.areas || typeof alert.areas !== 'string') return;

    const areas = alert.areas.split(',').map(s => s.trim());
    const relevantAreas = areas.filter(area => this.selectedCities.includes(area));
    const isTest = alert.alert_type === 0;

    if (relevantAreas.length > 0) {
      this.log.info(`Alert triggered for areas: ${relevantAreas.join(', ')}`);
      this.isAlertActive = true;
      this.alertActiveCities = relevantAreas;
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      );

      if (this.useChromecast) {
        this.playChromecastMedia(isTest);
      }

      setTimeout(() => {
        if (this.isAlertActive) {
          this.log.info('Auto-resetting alert state after timeout');
          this.isAlertActive = false;
          this.alertActiveCities = [];
          this.service.updateCharacteristic(
            Characteristic.ContactSensorState,
            Characteristic.ContactSensorState.CONTACT_DETECTED
          );
        }
      }, this.chromecastTimeout * 1000);
    } else if (alert.alert_type === 255) {
      this.log.info('Received all-clear signal');
      this.isAlertActive = false;
      this.alertActiveCities = [];
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
  }

  playChromecastMedia(isTest) {
    // Check if devices have been discovered
    const devices = this.chromecastClient.devices;
    if (!devices || devices.length === 0) {
      this.log.warn('No Chromecast devices found');
      return;
    }

    this.log.info(`Playing ${isTest ? 'test' : 'alert'} on Chromecast devices`);
    const mediaUrl = isTest ? `${this.baseUrl}/test-video` : `${this.baseUrl}/alert-video`;

    devices.forEach(device => {
      device.play(mediaUrl, (err) => {
        if (err) {
          this.log.error(`Error playing media on ${device.friendlyName}: ${err}`);
        } else {
          this.log.info(`Playing media on ${device.friendlyName}: ${mediaUrl}`);
        }
      });
    });
  }

  setupMediaServer() {
    this.server = express();
    const mediaDir = path.join(this.api.user.storagePath(), 'red-alert-media');
    fs.ensureDirSync(mediaDir);

    this.server.use(express.static(mediaDir));
    this.server.get('/alert-sound', (req, res) => res.sendFile(path.join(mediaDir, this.alertSoundPath)));
    this.server.get('/test-sound', (req, res) => res.sendFile(path.join(mediaDir, this.testSoundPath)));
    this.server.get('/alert-video', (req, res) => res.sendFile(path.join(mediaDir, this.alertVideoPath)));
    this.server.get('/test-video', (req, res) => res.sendFile(path.join(mediaDir, this.testVideoPath)));

    this.server.listen(this.serverPort, () => {
      this.log.info(`Media server running on port ${this.serverPort}`);
    });
  }

  copyDefaultMediaFiles() {
    const mediaDir = path.join(this.api.user.storagePath(), 'red-alert-media');
    const pluginDir = path.join(__dirname, 'media');

    try {
      if (fs.existsSync(pluginDir)) {
        fs.copySync(pluginDir, mediaDir, {overwrite: false});
        this.log.info('Default media files copied to storage directory');
      }
    } catch (error) {
      this.log.error(`Error copying default media files: ${error}`);
    }
  }

  getIpAddress() {
    const {networkInterfaces} = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (!net.internal && net.family === 'IPv4') {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('homebridge-red-alert', 'RedAlert', RedAlertPlugin);
};
