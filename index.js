/**
 * Homebridge Red Alert Plugin
 * A plugin for monitoring Israel's Red Alert system and sending notifications to Chromecast devices
 */

const WebSocket = require('ws');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const mdns = require('mdns-js');

let Service, Characteristic;

class RedAlertPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.name = config.name || 'Red Alert';
    this.selectedCities = config.cities || [];
    this.alertSoundPath = config.alertSoundPath || './sounds/alert.mp3';
    this.testSoundPath = config.testSoundPath || './sounds/test.mp3';
    this.alertVideoPath = config.alertVideoPath || './videos/alert.mp4';
    this.testVideoPath = config.testVideoPath || './videos/test.mp4';
    this.chromecastVolume = config.chromecastVolume || 30;
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
    this.server = null;

    // Initialize device caching
    this.cachedChromecastDevices = [];
    this.lastDeviceScan = 0;
    this.deviceScanInterval = 60000; // 1 minute

    // Setup express server for hosting media files
    this.setupMediaServer();

    // Only register once
    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.setupWebSocket();
        this.startChromecastDiscovery();
        this.copyDefaultMediaFiles();
      });
    }

    // Create the service
    this.service = new Service.ContactSensor(this.name);

    // Create test switch service
    this.testSwitchService = new Service.Switch(this.name + ' Test', 'test');
    this.testSwitchService
      .getCharacteristic(Characteristic.On)
      .on('set', this.handleTestSwitch.bind(this));
  }

  getServices() {
    // Information service
    const informationService = new Service.AccessoryInformation();

    informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Homebridge')
      .setCharacteristic(Characteristic.Model, 'Red Alert')
      .setCharacteristic(Characteristic.SerialNumber, '1.0.0');

    // Setup the main service
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

      // Turn off the switch after 2 seconds
      setTimeout(() => {
        this.testSwitchService.updateCharacteristic(Characteristic.On, false);
      }, 2000);
    }

    callback(null);
  }

  triggerTest() {
    // Simulate an alert for testing purposes
    this.isAlertActive = true;
    this.alertActiveCities = this.selectedCities.length > 0 ? [this.selectedCities[0]] : ['Test'];

    // Update the service state
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    // Trigger Chromecast for test alert
    if (this.useChromecast) {
      this.playChromecastMedia(true);
    }

    // Reset after 10 seconds
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
    this.connectWebSocket();
  }

  connectWebSocket() {
    if (this.wsClient) {
      this.wsClient.terminate();
    }

    this.log.info(`Connecting to WebSocket: ${this.wsUrl}`);

    this.wsClient = new WebSocket(this.wsUrl);

    this.wsClient.on('open', () => {
      this.log.info('WebSocket connected');
      // Clear any reconnect timer
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

    // Setup ping/pong for keeping connection alive
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
        this.connectWebSocket();
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

    // Basic validation
    if (!alert || !alert.areas || typeof alert.areas !== 'string') {
      this.log.error('Invalid alert format');
      return;
    }

    this.log.info(`Received alert: ${JSON.stringify(alert)}`);

    const areas = alert.areas.split(',').map(s => s.trim());

    // Check if any of the alert areas match our selected cities (using Hebrew IDs)
    const relevantAreas = areas.filter(area =>
      this.selectedCities.includes(area)
    );

    const isTest = alert.alert_type === 0; // Adjust based on actual data format

    if (relevantAreas.length > 0) {
      this.log.info(`Alert triggered for areas: ${relevantAreas.join(', ')}`);
      this.isAlertActive = true;
      this.alertActiveCities = relevantAreas;

      // Update HomeKit
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      );

      // Play on Chromecast
      if (this.useChromecast) {
        this.playChromecastMedia(isTest);
      }

      // Auto-reset after timeout (for safety, in case we miss the all-clear)
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
    } else if (alert.alert_type === 255) { // Assuming 255 is "all clear" - adjust based on actual data
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

    const scanForDevices = () => {
      const browser = mdns.createBrowser(mdns.tcp('googlecast'));

      browser.on('ready', () => {
        browser.discover();
      });

      browser.on('update', (service) => {
        if (!service.addresses || service.addresses.length === 0) return;

        const address = service.addresses[0];
        const name = service.name;
        const port = service.port || 8008; // Default to 8008 if not provided

        // Skip duplicates
        if (this.cachedChromecastDevices.some(device => device.address === address && device.port === port)) {
          return;
        }

        this.log.info(`Found Chromecast: ${name} at ${address}:${port}`);
        this.cachedChromecastDevices.push({
          name,
          address,
          port,
          type: service.type && service.type.length ? service.type[0].name : 'unknown'
        });
      });

      setTimeout(() => {
        browser.stop();
        this.lastDeviceScan = Date.now();
      }, 10000);
    };

    scanForDevices();
    setInterval(() => {
      if (Date.now() - this.lastDeviceScan > this.deviceScanInterval) {
        this.log.debug('Performing periodic Chromecast scan');
        scanForDevices();
      }
    }, 60000);
  }

  playChromecastMedia(isTest) {
    if (Date.now() - this.lastDeviceScan > this.deviceScanInterval) {
      this.startChromecastDiscovery();
    }

    this.log.info(`Playing ${isTest ? 'test' : 'alert'} on Chromecast devices`);

    if (this.cachedChromecastDevices.length === 0) {
      this.log.warn('No Chromecast devices found');
      return;
    }

    this.cachedChromecastDevices.forEach(device => {
      let mediaUrl;
      const isVideoCapable = device.type !== 'googlecast-audio';

      if (isVideoCapable) {
        mediaUrl = isTest ? `${this.baseUrl}/test-video` : `${this.baseUrl}/alert-video`;
      } else {
        mediaUrl = isTest ? `${this.baseUrl}/test-sound` : `${this.baseUrl}/alert-sound`;
      }

      this.castMedia(device, mediaUrl, isVideoCapable); // Pass device object
    });
  }

  castMedia(device, mediaUrl, isVideo) {
    const host = device.address;
    const port = device.port || 8008; // Fallback to 8008
    const client = new Client();

    client.connect({host, port}, () => {
      this.log.info(`Connected to Chromecast at ${host}:${port}`);

      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) {
          this.log.error(`Error launching media receiver: ${err}`);
          client.close();
          return;
        }

        const contentType = isVideo ? 'video/mp4' : 'audio/mp3';
        const media = {
          contentId: mediaUrl,
          contentType: contentType,
          streamType: 'BUFFERED',
        };

        client.setVolume({level: (this.chromecastVolume / 100)}, (err) => {
          if (err) this.log.error(`Error setting volume: ${err}`);
        });

        player.load(media, {autoplay: true}, (err) => {
          if (err) {
            this.log.error(`Error loading media: ${err}`);
          } else {
            this.log.info(`Playing media: ${mediaUrl}`);
          }
          setTimeout(() => {
            client.close();
          }, this.chromecastTimeout * 1000);
        });
      });
    });

    client.on('error', (err) => {
      this.log.error(`Chromecast client error: ${err}`);
      client.close();
    });
  }

  setupMediaServer() {
    this.server = express();

    // Serve static files from the media directory
    const mediaDir = path.join(this.api.user.storagePath(), 'node_modules/homebridge-red-alert', 'media');
    this.server.use(express.static(mediaDir));

    // Routes for media files
    this.server.get('/alert-sound', (req, res) => {
      res.sendFile(path.join(mediaDir, path.basename(this.alertSoundPath)));
    });

    this.server.get('/test-sound', (req, res) => {
      res.sendFile(path.join(mediaDir, path.basename(this.testSoundPath)));
    });

    this.server.get('/alert-video', (req, res) => {
      res.sendFile(path.join(mediaDir, path.basename(this.alertVideoPath)));
    });

    this.server.get('/test-video', (req, res) => {
      res.sendFile(path.join(mediaDir, path.basename(this.testVideoPath)));
    });

    // Start server
    this.server.listen(this.serverPort, () => {
      this.log.info(`Media server running on port ${this.serverPort}`);
    });
  }

  copyDefaultMediaFiles() {
    const mediaDir = path.join(this.api.user.storagePath(), 'red-alert-media');

    // Create directory if it doesn't exist
    fs.ensureDirSync(mediaDir);

    // Copy default media files if they exist in the plugin directory
    const pluginDir = path.join(__dirname, 'media');

    try {
      if (fs.existsSync(pluginDir)) {
        fs.copySync(pluginDir, mediaDir);
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
        // Skip internal and non-IPv4 addresses
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