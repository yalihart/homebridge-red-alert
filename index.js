/**
 * Homebridge Red Alert Plugin
 * A plugin for monitoring Israel's Red Alert system and sending notifications to Chromecast devices using castv2
 */

const WebSocket = require('ws');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const {Client} = require('castv2');
const mdns = require('mdns-js');

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
    this.chromecastVolume = config.chromecastVolume || 30; // 0-100
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
    this.chromecastDevices = [];

    // Setup media server and Chromecast discovery
    this.setupMediaServer();
    this.startChromecastDiscovery();

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

  startChromecastDiscovery() {
    this.log.info('Starting Chromecast discovery');
    this.chromecastDevices = [];

    const browser = mdns.createBrowser(mdns.tcp('googlecast'));

    browser.on('serviceUp', (service) => {
      if (!service.addresses || service.addresses.length === 0) return;

      const host = service.addresses[0];
      const port = service.port || 8009; // Default CASTV2 port
      const name = service.name || 'Unnamed Device';

      if (!this.chromecastDevices.some(d => d.host === host && d.port === port)) {
        this.log.info(`Found device: ${name} at ${host}:${port}`);
        this.chromecastDevices.push({name, host, port});
      }
    });

    browser.start();

    setTimeout(() => {
      browser.stop();
      this.log.info(`Chromecast discovery completed. Found ${this.chromecastDevices.length} devices.`);
    }, 10000);

    setInterval(() => {
      this.log.debug('Performing periodic Chromecast scan');
      this.startChromecastDiscovery();
    }, 60000);
  }

  playChromecastMedia(isTest) {
    if (this.chromecastDevices.length === 0) {
      this.log.warn('No Chromecast devices found');
      return;
    }

    this.log.info(`Playing ${isTest ? 'test' : 'alert'} on Chromecast devices`);

    const mediaUrl = isTest ? `${this.baseUrl}/test-video` : `${this.baseUrl}/alert-video`;
    const contentType = 'video/mp4';

    this.chromecastDevices.forEach(device => {
      this.castMedia(device, mediaUrl, contentType);
    });
  }

  castMedia(device, mediaUrl, contentType) {
    const client = new Client();

    client.connect({host: device.host, port: device.port}, () => {
      this.log.info(`Connected to device: ${device.name} at ${device.host}:${device.port}`);

      // Create channels
      const connection = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
      const heartbeat = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', 'JSON');
      const receiver = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', 'JSON');
      const media = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.media', 'JSON');

      // Establish connection
      connection.send({type: 'CONNECT'});

      // Start heartbeating
      const heartbeatInterval = setInterval(() => {
        heartbeat.send({type: 'PING'});
      }, 5000);

      // Launch Default Media Receiver
      receiver.send({type: 'LAUNCH', appId: 'CC1AD845', requestId: 1});

      receiver.on('message', (data) => {
        if (data.type === 'RECEIVER_STATUS' && data.status && data.status.applications) {
          const app = data.status.applications[0];
          if (app && app.appId === 'CC1AD845') {
            // Set volume
            receiver.send({
              type: 'SET_VOLUME',
              volume: {level: this.chromecastVolume / 100},
              requestId: 2
            });

            // Load media
            media.send({
              type: 'LOAD',
              media: {
                contentId: mediaUrl,
                contentType: contentType,
                streamType: 'BUFFERED'
              },
              autoplay: true,
              requestId: 3
            });

            media.on('message', (data) => {
              if (data.type === 'MEDIA_STATUS' && data.status && data.status[0].playerState === 'PLAYING') {
                this.log.info(`Playing media on ${device.name}: ${mediaUrl}`);
                setTimeout(() => {
                  receiver.send({type: 'STOP', sessionId: app.sessionId, requestId: 4});
                  clearInterval(heartbeatInterval);
                  client.close();
                  this.log.info(`Stopped media on ${device.name}`);
                }, this.chromecastTimeout * 1000);
              }
            });
          }
        }
      });
    });

    client.on('error', (err) => {
      this.log.error(`Chromecast error for ${device.name}: ${err.message}`);
      clearInterval(heartbeatInterval);
      client.close();
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