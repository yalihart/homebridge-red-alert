/**
 * Homebridge Red Alert Plugin
 * Monitors Israel's Red Alert system and sends notifications to Chromecast devices.
 * Integrates with HomeKit for alert state and test functionality.
 */

const WebSocket = require('ws');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const ChromecastAPI = require('chromecast-api');

let Service, Characteristic;

class RedAlertPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // Plugin configuration with defaults
    this.name = config.name || 'Red Alert';
    this.selectedCities = config.cities || []; // Cities to monitor for alerts
    this.alertSoundPath = config.alertSoundPath || 'sounds/alert.mp3';
    this.testSoundPath = config.testSoundPath || 'sounds/test.mp3';
    this.alertVideoPath = config.alertVideoPath || 'videos/alert.mp4';
    this.testVideoPath = config.testVideoPath || 'videos/test.mp4';
    this.chromecastVolume = config.chromecastVolume || 30; // Volume in percentage
    this.useChromecast = config.useChromecast !== false; // Enable Chromecast by default
    this.chromecastTimeout = config.chromecastTimeout || 30; // Timeout in seconds
    this.wsUrl = config.wsUrl || 'ws://ws.cumta.morhaviv.com:25565/ws';
    this.reconnectInterval = config.reconnectInterval || 5000; // Reconnect delay in ms
    this.serverPort = config.serverPort || 8095;
    this.baseUrl = config.baseUrl || `http://${this.getIpAddress()}:${this.serverPort}`;

    // State variables
    this.isAlertActive = false;
    this.alertActiveCities = [];
    this.wsClient = null;
    this.reconnectTimer = null;
    this.devices = []; // Store discovered Chromecast devices

    // Validate critical configuration
    if (!this.wsUrl) this.log.error('WebSocket URL is missing in configuration');


    // Initialize Chromecast discovery if enabled
    if (this.useChromecast) {
      this.setupChromecastDiscovery();
    }

    // Setup WebSocket and media files on Homebridge launch
    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('Homebridge Red Alert: System Did Finish Launching. Initializing components...');
        this.setupMediaServer(); // Now called here
        if (this.useChromecast) {
          this.setupChromecastDiscovery(); // Now called here
        }
        this.setupWebSocket();
        this.copyDefaultMediaFiles();
      });
    }

    // HomeKit services
    this.service = new Service.ContactSensor(this.name);
    this.testSwitchService = new Service.Switch(`${this.name} Test`, 'test');
    this.testSwitchService
      .getCharacteristic(Characteristic.On)
      .on('set', this.handleTestSwitch.bind(this));
  }

  // Expose HomeKit services
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

  // Get current alert state for HomeKit
  getAlertState(callback) {
    this.log.debug(`Getting alert state: ${this.isAlertActive}`);
    callback(null, this.isAlertActive
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED);
  }

  // Handle test switch toggle from HomeKit
  handleTestSwitch(on, callback) {
    if (on) {
      this.log.info('Running alert test');
      this.triggerTest();
      setTimeout(() => {
        this.testSwitchService.updateCharacteristic(Characteristic.On, false);
      }, 2000); // Reset switch after 2 seconds
    }
    callback(null);
  }

  // Trigger a test alert
  triggerTest() {
    this.isAlertActive = true;
    this.alertActiveCities = this.selectedCities.length > 0 ? [this.selectedCities[0]] : ['Test'];
    this.log.info(`Test alert triggered for: ${this.alertActiveCities.join(', ')}`);
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
      this.log.info('Test alert reset');
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }, 10000); // Reset after 10 seconds
  }

  // Setup continuous Chromecast device discovery
  setupChromecastDiscovery() {
    this.initializeChromecastClient();
    setInterval(() => {
      this.log.info('Reinitializing Chromecast client for rediscovery...');
      this.devices = [];
      this.initializeChromecastClient();
    }, 300000); // Every 5 minutes
  }

  // Initialize Chromecast client and set up event listener
  initializeChromecastClient() {
    try {
      this.chromecastClient = new ChromecastAPI();
  
      this.chromecastClient.on('device', (device) => {
        try {
          if (!device || typeof device.host !== 'string' || typeof device.friendlyName !== 'string') {
            this.log.warn(`Discovered Chromecast device with incomplete data: ${JSON.stringify(device)}. Skipping.`);
            return;
          }
          if (typeof device.play !== 'function' || typeof device.setVolume !== 'function') {
              this.log.warn(`Discovered Chromecast device '${device.friendlyName}' but it lacks essential playback functions. Skipping.`);
              return;
          }
          this.log.info(`Chromecast discovered: ${device.friendlyName} at ${device.host}`);
          if (!this.devices.some(d => d.host === device.host)) {
            this.devices.push(device);
          }
        } catch (error) {
          this.log.error(`Error processing discovered Chromecast device: ${error.message}`, error.stack);
        }
      });
  
      // Listen for global errors on the chromecastClient instance
      this.chromecastClient.on('error', (err) => {
          this.log.error(`ChromecastAPI client error: ${err.message}`, err.stack);
          // You might want to implement logic to re-initialize or temporarily disable Chromecast features
      });
  
  } catch (error) {
      this.log.error(`Failed to initialize ChromecastAPI: ${error.message}`, error.stack);
      this.useChromecast = false; // Fallback: disable Chromecast features if initialization fails
      this.devices = [];
      this.log.warn('Chromecast functionality has been disabled due to an initialization error.');
  }
  }

  // Setup WebSocket connection with automatic reconnection
  setupWebSocket() {
    if (this.wsClient) {
      this.wsClient.terminate();
    }

    this.log.info(`Connecting to WebSocket: ${this.wsUrl}`);
    this.wsClient = new WebSocket(this.wsUrl);

    this.wsClient.on('open', () => {
      this.log.info('WebSocket connected');
      this.log.info(`Monitoring cities: ${this.selectedCities.join(', ')}`);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.wsClient.on('message', (data) => {
      try {
        this.handleAlertMessage(data.toString());
      } catch (error) {
        this.log.error(`Error processing WebSocket message: ${error.message}`);
      }
    });

    this.wsClient.on('error', (error) => {
      this.log.error(`WebSocket error: ${error.message}`);
      this.scheduleReconnect();
    });

    this.wsClient.on('close', () => {
      this.log.warn('WebSocket connection closed');
      this.scheduleReconnect();
    });

    // Send periodic pings to keep connection alive
    const pingInterval = setInterval(() => {
      if (this.wsClient.readyState === WebSocket.OPEN) {
        this.wsClient.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Every 30 seconds
  }

  // Schedule WebSocket reconnection
  scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.log.info(`Scheduling WebSocket reconnect in ${this.reconnectInterval / 1000} seconds`);
      this.reconnectTimer = setTimeout(() => {
        this.setupWebSocket();
      }, this.reconnectInterval);
    }
  }

  // Handle incoming WebSocket alert messages
  handleAlertMessage(message) {
    let alert;
    try {
      alert = JSON.parse(message);
    } catch (error) {
      this.log.error(`Failed to parse alert message: ${error.message}`);
      return;
    }

    if (!alert || !alert.areas || typeof alert.areas !== 'string') {
      this.log.warn('Invalid alert message format');
      return;
    }

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

  // Play media on Chromecast devices with retry logic
  playChromecastMedia(isTest) {
    this.log.debug(`Attempting to play media on ${this.devices.length} Chromecast devices`);
    if (!this.devices.length) {
      this.log.warn('No Chromecast devices available to play media');
      return;
    }

    this.log.info(`Playing ${isTest ? 'test' : 'alert'} on ${this.devices.length} Chromecast devices`);
    const mediaUrl = isTest ? `${this.baseUrl}/test-video` : `${this.baseUrl}/alert-video`;

    this.devices.forEach((device, index) => {
      if (!device || typeof device.setVolume !== 'function' || typeof device.play !== 'function') {
        this.log.warn(`Device at index ${index} is invalid or not fully initialized, skipping`);
        return;
      }

      this.playWithRetry(device, mediaUrl, 3); // Retry up to 3 times
    });
  }

  // Helper method to play media with retry logic
  playWithRetry(device, mediaUrl, retries) {
    device.play(mediaUrl, (err) => {
      if (err && retries > 0) {
        this.log.warn(`Retrying media playback on ${device.friendlyName || 'unknown'} (${retries} attempts left)`);
        setTimeout(() => this.playWithRetry(device, mediaUrl, retries - 1), 2000);
      } else if (err) {
        this.log.error(`Failed to play media on ${device.friendlyName || 'unknown'} after retries: ${err.message}`);
      } else {
        this.log.info(`Playing media on ${device.friendlyName || 'unknown'}: ${mediaUrl}`);
        // Set volume after playback starts
        const deviceVolume = this.config.chromecastVolumes?.find(
          v => v.deviceName.toLowerCase() === device.friendlyName.toLowerCase()
        )?.volume ?? this.config.chromecastVolume;

        // Set the volume (Chromecast expects a value between 0 and 1, so divide by 100)
        device.setVolume(deviceVolume / 100, (err) => {
          if (err) {
            this.log.warn(`Failed to set volume on ${device.friendlyName || 'unknown'}: ${err.message}`);
          } else {
            this.log.debug(`Volume set to ${deviceVolume}% on ${device.friendlyName || 'unknown'}`);
          }
        });
      }
    });
  }

  // Setup Express server to serve media files
  setupMediaServer() {
    this.server = express();
    const mediaDir = path.join(this.api.user.storagePath(), 'red-alert-media');
    fs.ensureDirSync(mediaDir);

    this.server.use(express.static(mediaDir));
    this.server.get('/alert-sound', (req, res) => res.sendFile(path.join(mediaDir, this.alertSoundPath)));
    this.server.get('/test-sound', (req, res) => res.sendFile(path.join(mediaDir, this.testSoundPath)));
    this.server.get('/alert-video', (req, res) => res.sendFile(path.join(mediaDir, this.alertVideoPath)));
    this.server.get('/test-video', (req, res) => res.sendFile(path.join(mediaDir, this.testVideoPath)));
    this.server.get('/health', (req, res) => {
      this.log.debug('Media server health check accessed');
      res.status(200).send('OK');
    });

    this.server.listen(this.serverPort, () => {
      this.log.info(`Media server running on port ${this.serverPort}`);
    });
  }

  // Copy default media files to storage if they don’t exist
  copyDefaultMediaFiles() {
    const mediaDir = path.join(this.api.user.storagePath(), 'red-alert-media');
    const pluginDir = path.join(__dirname, 'media');

    try {
      if (fs.existsSync(pluginDir)) {
        fs.copySync(pluginDir, mediaDir, {overwrite: false});
        this.log.info('Default media files copied to storage directory');
      }
    } catch (error) {
      this.log.error(`Error copying default media files: ${error.message}`);
    }
  }

  // Get local IP address for media server URL
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
    this.log.warn('No valid network interface found, using localhost');
    return '127.0.0.1';
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('homebridge-red-alert', 'RedAlert', RedAlertPlugin);
};