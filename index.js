/**
 * Homebridge Red Alert Plugin
 * Monitors Israel's Red Alert system and sends notifications to Chromecast devices.
 * Integrates with HomeKit for alert state and test functionality.
 */

const WebSocket = require("ws");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
const ChromecastAPI = require("chromecast-api");

let Service, Characteristic;

class RedAlertPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // Plugin configuration with defaults
    this.name = config.name || "Red Alert";
    this.selectedCities = Array.isArray(config.cities) ? config.cities : [];
    this.alertSoundPath = config.alertSoundPath || "sounds/alert.mp3";
    this.testSoundPath = config.testSoundPath || "sounds/test.mp3";
    this.alertVideoPath = config.alertVideoPath || "videos/alert.mp4";
    this.testVideoPath = config.testVideoPath || "videos/test.mp4";
    this.chromecastVolume = Number.isFinite(config.chromecastVolume)
      ? config.chromecastVolume
      : 30;
    this.useChromecast = config.useChromecast !== false;
    this.chromecastTimeout = Number.isFinite(config.chromecastTimeout)
      ? config.chromecastTimeout
      : 30;
    this.wsUrl = config.wsUrl || "ws://ws.cumta.morhaviv.com:25565/ws";
    this.reconnectInterval = Number.isFinite(config.reconnectInterval)
      ? config.reconnectInterval
      : 5000;
    this.serverPort = Number.isFinite(config.serverPort)
      ? config.serverPort
      : 8095;
    this.baseUrl =
      config.baseUrl || `http://${this.getIpAddress()}:${this.serverPort}`;

    // State variables
    this.isAlertActive = false;
    this.alertActiveCities = [];
    this.wsClient = null;
    this.reconnectTimer = null;
    this.devices = [];

    // Validate configuration
    this.validateConfig();

    // Setup on Homebridge launch
    if (this.api) {
      this.api.on("didFinishLaunching", () => {
        try {
          this.log.info("Initializing Red Alert plugin components...");
          this.setupMediaServer();
          if (this.useChromecast) this.setupChromecastDiscovery();
          this.setupWebSocket();
          this.copyDefaultMediaFiles();
        } catch (error) {
          this.log.error(`Failed to initialize components: ${error.message}`);
        }
      });
    }

    // HomeKit services
    try {
      this.service = new Service.ContactSensor(this.name);
      this.testSwitchService = new Service.Switch(`${this.name} Test`, "test");
      this.testSwitchService
        .getCharacteristic(Characteristic.On)
        .on("set", this.handleTestSwitch.bind(this));
    } catch (error) {
      this.log.error(`Failed to initialize HomeKit services: ${error.message}`);
    }
  }

  // Validate configuration
  validateConfig() {
    try {
      if (!this.wsUrl) {
        this.log.warn("WebSocket URL missing, using default: " + this.wsUrl);
      }
      if (
        !Array.isArray(this.selectedCities) ||
        this.selectedCities.length === 0
      ) {
        this.log.warn(
          "No valid cities specified in config, monitoring all alerts"
        );
        this.selectedCities = [];
      }
      if (this.useChromecast && Array.isArray(this.config.chromecastVolumes)) {
        this.config.chromecastVolumes.forEach((v, i) => {
          if (!v.deviceName || !Number.isFinite(v.volume)) {
            this.log.warn(
              `Invalid Chromecast volume config at index ${i}, ignoring`
            );
          }
        });
      }
    } catch (error) {
      this.log.error(`Configuration validation failed: ${error.message}`);
    }
  }

  // Expose HomeKit services
  getServices() {
    try {
      const informationService = new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
        .setCharacteristic(Characteristic.Model, "Red Alert")
        .setCharacteristic(Characteristic.SerialNumber, "1.0.0");

      this.service
        .getCharacteristic(Characteristic.ContactSensorState)
        .on("get", this.getAlertState.bind(this));

      return [informationService, this.service, this.testSwitchService];
    } catch (error) {
      this.log.error(`Failed to expose services: ${error.message}`);
      return [];
    }
  }

  // Get current alert state for HomeKit
  getAlertState(callback) {
    try {
      this.log.debug(`Getting alert state: ${this.isAlertActive}`);
      callback(
        null,
        this.isAlertActive
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    } catch (error) {
      this.log.error(`Error getting alert state: ${error.message}`);
      callback(error);
    }
  }

  // Handle test switch toggle from HomeKit
  handleTestSwitch(on, callback) {
    try {
      if (on) {
        this.log.info("Running alert test");
        this.triggerTest();
        setTimeout(() => {
          this.testSwitchService.updateCharacteristic(Characteristic.On, false);
        }, 2000);
      }
      callback(null);
    } catch (error) {
      this.log.error(`Error handling test switch: ${error.message}`);
      callback(error);
    }
  }

  // Trigger a test alert
  triggerTest() {
    try {
      this.isAlertActive = true;
      this.alertActiveCities =
        this.selectedCities.length > 0 ? [this.selectedCities[0]] : ["Test"];
      this.log.info(
        `Test alert triggered for: ${this.alertActiveCities.join(", ")}`
      );
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
        this.log.info("Test alert reset");
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }, 10000);
    } catch (error) {
      this.log.error(`Error triggering test: ${error.message}`);
    }
  }

  // Setup continuous Chromecast device discovery
  setupChromecastDiscovery() {
    try {
      this.initializeChromecastClient();
      setInterval(() => {
        this.log.info("Reinitializing Chromecast client for rediscovery...");
        this.devices = [];
        this.initializeChromecastClient();
      }, 300000);
    } catch (error) {
      this.log.error(`Failed to setup Chromecast discovery: ${error.message}`);
    }
  }

  // Initialize Chromecast client
  initializeChromecastClient() {
    try {
      this.chromecastClient = new ChromecastAPI();
      this.chromecastClient.on("device", (device) => {
        try {
          if (!device || !device.host || !device.friendlyName) {
            this.log.warn(
              `Invalid Chromecast device data: ${JSON.stringify(device)}`
            );
            return;
          }
          if (
            typeof device.play !== "function" ||
            typeof device.setVolume !== "function"
          ) {
            this.log.warn(
              `Chromecast '${device.friendlyName}' lacks playback functions`
            );
            return;
          }
          this.log.info(
            `Chromecast discovered: ${device.friendlyName} at ${device.host}`
          );
          if (!this.devices.some((d) => d.host === device.host)) {
            this.devices.push(device);
          }
          if (
            this.config.chromecastVolumes &&
            !this.devices.some((d) =>
              this.config.chromecastVolumes.some(
                (v) => v.deviceName === d.friendlyName
              )
            )
          ) {
            this.log.warn("Some configured Chromecast devices not discovered");
          }
        } catch (error) {
          this.log.error(
            `Error processing Chromecast device: ${error.message}`
          );
        }
      });
      this.chromecastClient.on("error", (err) => {
        this.log.error(`ChromecastAPI error: ${err.message}`);
      });
    } catch (error) {
      this.log.error(`Failed to initialize Chromecast: ${error.message}`);
      this.useChromecast = false;
      this.devices = [];
      this.log.warn(
        "Chromecast functionality disabled due to initialization failure"
      );
    }
  }

  // Setup WebSocket connection
  setupWebSocket() {
    try {
      if (this.wsClient) {
        this.wsClient.terminate();
      }
      this.log.info(`Connecting to WebSocket: ${this.wsUrl}`);
      this.wsClient = new WebSocket(this.wsUrl);

      this.wsClient.on("open", () => {
        this.log.info("WebSocket connected");
        this.log.info(
          `Monitoring cities: ${this.selectedCities.join(", ") || "all"}`
        );
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.wsClient.on("message", (data) => {
        try {
          this.handleAlertMessage(data.toString());
        } catch (error) {
          this.log.error(
            `Error processing WebSocket message: ${error.message}`
          );
        }
      });

      this.wsClient.on("error", (error) => {
        this.log.error(`WebSocket error: ${error.message}`);
        this.scheduleReconnect();
      });

      this.wsClient.on("close", () => {
        this.log.warn("WebSocket connection closed");
        this.scheduleReconnect();
      });

      const pingInterval = setInterval(() => {
        if (this.wsClient.readyState === WebSocket.OPEN) {
          this.wsClient.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
    } catch (error) {
      this.log.error(`Failed to setup WebSocket: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  // Schedule WebSocket reconnection
  scheduleReconnect() {
    try {
      if (!this.reconnectTimer) {
        this.log.info(
          `Scheduling WebSocket reconnect in ${
            this.reconnectInterval / 1000
          } seconds`
        );
        this.reconnectTimer = setTimeout(() => {
          this.setupWebSocket();
        }, this.reconnectInterval);
      }
    } catch (error) {
      this.log.error(`Error scheduling reconnect: ${error.message}`);
    }
  }

  // Handle WebSocket alert messages
  handleAlertMessage(message) {
    try {
      const alert = JSON.parse(message);
      if (!alert || !alert.areas || typeof alert.areas !== "string") {
        this.log.warn("Invalid alert message format");
        return;
      }

      const areas = alert.areas.split(",").map((s) => s.trim());
      const relevantAreas = areas.filter(
        (area) =>
          this.selectedCities.length === 0 || this.selectedCities.includes(area)
      );
      const isTest = alert.alert_type === 0;

      if (relevantAreas.length > 0) {
        this.log.info(`Alert triggered for areas: ${relevantAreas.join(", ")}`);
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
            this.log.info("Auto-resetting alert state");
            this.isAlertActive = false;
            this.alertActiveCities = [];
            this.service.updateCharacteristic(
              Characteristic.ContactSensorState,
              Characteristic.ContactSensorState.CONTACT_DETECTED
            );
          }
        }, this.chromecastTimeout * 1000);
      } else if (alert.alert_type === 255) {
        this.log.info("Received all-clear signal");
        this.isAlertActive = false;
        this.alertActiveCities = [];
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }
    } catch (error) {
      this.log.error(`Error handling alert message: ${error.message}`);
    }
  }

  // Play media on Chromecast devices
  playChromecastMedia(isTest) {
    try {
      if (!this.devices.length) {
        this.log.warn("No Chromecast devices available");
        return;
      }

      // Filter devices to ensure they are valid
      const validDevices = this.devices.filter(
        (device) =>
          device &&
          typeof device.play === "function" &&
          typeof device.setVolume === "function" &&
          device.friendlyName &&
          device.host
      );

      if (!validDevices.length) {
        this.log.warn("No valid Chromecast devices available after filtering");
        return;
      }

      this.log.info(
        `Playing ${isTest ? "test" : "alert"} on ${validDevices.length} devices`
      );
      const mediaUrl = isTest
        ? `${this.baseUrl}/test-video`
        : `${this.baseUrl}/alert-video`;

      validDevices.forEach((device) => {
        this.playWithRetry(device, mediaUrl, 3);
      });
    } catch (error) {
      this.log.error(`Error playing Chromecast media: ${error.message}`);
    }
  }

  // Play media with retry logic
  playWithRetry(device, mediaUrl, retries) {
    try {
      // Log device state for debugging (optional, remove if too verbose)
      this.log.debug(
        `Attempting playback on ${device.friendlyName}, host: ${device.host}`
      );

      device.play(mediaUrl, (err) => {
        if (err && retries > 0) {
          this.log.warn(
            `Retrying playback on ${device.friendlyName} (${retries} left)`
          );
          setTimeout(
            () => this.playWithRetry(device, mediaUrl, retries - 1),
            2000
          );
        } else if (err) {
          this.log.error(
            `Failed to play on ${device.friendlyName}: ${err.message}`
          );
        } else {
          this.log.info(`Playing on ${device.friendlyName}: ${mediaUrl}`);
          const deviceVolume =
            this.config.chromecastVolumes?.find(
              (v) =>
                v.deviceName.toLowerCase() === device.friendlyName.toLowerCase()
            )?.volume ?? this.chromecastVolume;
          device.setVolume(deviceVolume / 100, (err) => {
            if (err) {
              this.log.warn(
                `Failed to set volume on ${device.friendlyName}: ${err.message}`
              );
            } else {
              this.log.debug(
                `Volume set to ${deviceVolume}% on ${device.friendlyName}`
              );
            }
          });
        }
      });
    } catch (error) {
      this.log.error(
        `Synchronous error playing on ${device.friendlyName}: ${error.message}`
      );
      if (retries > 0) {
        this.log.warn(
          `Retrying playback on ${device.friendlyName} (${retries} left)`
        );
        setTimeout(
          () => this.playWithRetry(device, mediaUrl, retries - 1),
          2000
        );
      } else {
        this.log.error(
          `Giving up on ${device.friendlyName} after all retries exhausted`
        );
      }
    }
  }

  // Setup Express media server
  setupMediaServer() {
    try {
      this.server = express();
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      fs.ensureDirSync(mediaDir);

      this.server.use(express.static(mediaDir));
      this.server.get("/alert-sound", (req, res) =>
        res.sendFile(path.join(mediaDir, this.alertSoundPath))
      );
      this.server.get("/test-sound", (req, res) =>
        res.sendFile(path.join(mediaDir, this.testSoundPath))
      );
      this.server.get("/alert-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.alertVideoPath))
      );
      this.server.get("/test-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.testVideoPath))
      );
      this.server.get("/health", (req, res) => {
        this.log.debug("Media server health check");
        res.status(200).send("OK");
      });

      this.server
        .listen(this.serverPort, () => {
          this.log.info(`Media server running on port ${this.serverPort}`);
        })
        .on("error", (err) => {
          this.log.error(`Media server error: ${err.message}`);
        });
    } catch (error) {
      this.log.error(`Failed to setup media server: ${error.message}`);
    }
  }

  // Copy default media files
  copyDefaultMediaFiles() {
    try {
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      const pluginDir = path.join(__dirname, "media");
      if (fs.existsSync(pluginDir)) {
        fs.copySync(pluginDir, mediaDir, { overwrite: false });
        this.log.info("Default media files copied");
      }
    } catch (error) {
      this.log.error(`Error copying media files: ${error.message}`);
    }
  }

  // Get local IP address
  getIpAddress() {
    try {
      const { networkInterfaces } = require("os");
      const nets = networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (!net.internal && net.family === "IPv4") {
            return net.address;
          }
        }
      }
      this.log.warn("No valid network interface, using localhost");
      return "127.0.0.1";
    } catch (error) {
      this.log.error(`Error getting IP address: ${error.message}`);
      return "127.0.0.1";
    }
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory("homebridge-red-alert", "RedAlert", RedAlertPlugin);
};
