# Homebridge Red Alert Plugin

This Homebridge plugin provides comprehensive integration with Israel's Red Alert system, allowing you to monitor both primary alerts and early warning notifications for specified cities and receive notifications via HomeKit and Chromecast devices.

## Features

### Primary Alert System
- Real-time monitoring of Red Alert system via WebSocket for immediate threats
- Primary alerts (rocket/missile threats) with highest priority
- Automatic interruption of early warnings when primary alerts occur

### Early Warning System
- Polling-based monitoring of OREF early warning alerts (category 13)
- Advanced early warning notifications for "alerts expected in your area soon"
- Time-based restrictions (configurable hours, default 10 AM - 8 PM)
- Reduced volume playback (configurable reduction, default 20% less than primary alerts)
- Smart duplicate prevention with 60-second alert window
- Automatic cleanup of processed alerts to prevent memory leaks

### HomeKit Integration
- Contact sensor for primary alerts that activates during threats
- Separate contact sensor for early warning alerts
- Test button to simulate primary alerts
- Real-time status updates in HomeKit

### Chromecast Integration
- Automatic discovery and playback on all compatible Chromecast devices
- Support for both audio and video playback based on device capabilities
- Per-device volume configuration support
- Retry logic for failed playback attempts
- Priority-based media selection (primary vs early warning vs test)

### Technical Features
- Configurable city selection for targeted monitoring
- Automatic reconnection to WebSocket if connection is lost
- Local media server for hosting alert sounds and videos
- Robust error handling and graceful fallbacks
- Comprehensive logging for monitoring and debugging

## Installation

Install this plugin using npm:

```bash
npm install -g homebridge-red-alert
```
## Configuration

Add the following to your Homebridge `config.json` file:

```json
{
    "accessories": [
        {
            "accessory": "RedAlert",
            "name": "Red Alert",
            "cities": [
                "רעננה",
                "תל אביב"
            ],
            "useChromecast": true,
            "chromecastVolume": 100,
            "chromecastVolumes": [
                {
                    "deviceName": "Living Room TV",
                    "volume": 40
                },
                {
                    "deviceName": "Bedroom TV", 
                    "volume": 30
                }
            ],
            "chromecastTimeout": 30,
            "enableEarlyWarning": true,
            "earlyWarningStartHour": 10,
            "earlyWarningEndHour": 20,
            "earlyWarningVolumeReduction": 20,
            "earlyWarningPollInterval": 8000,
            "wsUrl": "ws://ws.cumta.morhaviv.com:25565/ws",
            "reconnectInterval": 5000,
            "serverPort": 8095
        }
    ]
}
```

## Configuration Options

### Basic Settings
| Option              | Description                                             | Default                               |
|---------------------|---------------------------------------------------------|---------------------------------------|
| `name`              | Name of the accessory in HomeKit                        | "Red Alert"                           |
| `cities`            | Array of cities to monitor for alerts (Hebrew names)    | []                                    |
| `useChromecast`     | Enable sending alerts to Chromecast devices             | true                                  |
| `serverPort`        | Port to use for the media server                        | 8095                                  |

### Primary Alert Settings
| Option              | Description                                             | Default                               |
|---------------------|---------------------------------------------------------|---------------------------------------|
| `wsUrl`             | WebSocket URL for Red Alert API                         | "ws://ws.cumta.morhaviv.com:25565/ws" |
| `reconnectInterval` | How often to attempt reconnection to WebSocket (ms)     | 5000                                  |
| `chromecastTimeout` | How long to play alerts on Chromecast devices (seconds) | 30                                    |

### Early Warning Settings
| Option                        | Description                                           | Default                               |
|-------------------------------|-------------------------------------------------------|---------------------------------------|
| `enableEarlyWarning`          | Enable early warning monitoring                       | true                                  |
| `earlyWarningStartHour`       | Start hour for early warning notifications (0-23)    | 10 (10 AM)                           |
| `earlyWarningEndHour`         | End hour for early warning notifications (0-23)      | 20 (8 PM)                            |
| `earlyWarningVolumeReduction` | Volume reduction percentage for early warnings        | 20                                    |
| `earlyWarningPollInterval`    | How often to check for early warnings (ms)           | 8000 (8 seconds)                     |
| `orefHistoryUrl`              | OREF API endpoint for early warning alerts           | Auto-configured                       |

### Chromecast Settings
| Option               | Description                                            | Default     |
|----------------------|--------------------------------------------------------|-------------|
| `chromecastVolume`   | Default volume for all Chromecast devices (0-100)     | 30          |
| `chromecastVolumes`  | Per-device volume configuration array                  | []          |

### Media File Settings
| Option                     | Description                                | Default                    |
|----------------------------|--------------------------------------------|----------------------------|
| `alertSoundPath`           | Path to the sound file for primary alerts | "sounds/alert.mp3"         |
| `testSoundPath`            | Path to the sound file for test alerts    | "sounds/test.mp3"          |
| `alertVideoPath`           | Path to the video file for primary alerts | "videos/alert.mp4"         |
| `testVideoPath`            | Path to the video file for test alerts    | "videos/test.mp4"          |
| `earlyWarningSoundPath`    | Path to the sound file for early warnings | "sounds/early.mp3"         |
| `earlyWarningVideoPath`    | Path to the video file for early warnings | "videos/early.mp4"         |

## Alert Types and Priorities

### Primary Alerts (Highest Priority)
- **Source**: Real-time WebSocket connection
- **Types**: Rocket/missile threats, air raid sirens
- **Behavior**: 
  - Plays at full configured volume
  - Interrupts any playing early warnings
  - Activates primary alert contact sensor
  - Cannot be interrupted by early warnings

### Early Warning Alerts (Lower Priority)
- **Source**: OREF API polling every 8 seconds
- **Types**: "Alerts expected in your area soon" notifications
- **Behavior**:
  - Plays at reduced volume (20% less than primary alerts)
  - Only plays during configured hours (10 AM - 8 PM by default)
  - Skipped if primary alert is active
  - 60-second alert window prevents replaying same alerts
  - Activates early warning contact sensor

### Test Alerts
- **Source**: Manual trigger via HomeKit switch
- **Behavior**: Simulates primary alert for testing purposes

## Custom Media Files

To use custom media files, place them in the Homebridge storage directory under `red-alert-media/`.

Example directory structure:
```
/path/to/homebridge/storage/red-alert-media/
├── sounds/
│   ├── alert.mp3      # Primary alert sound
│   ├── test.mp3       # Test alert sound
│   └── early.mp3      # Early warning sound
└── videos/
    ├── alert.mp4      # Primary alert video
    ├── test.mp4       # Test alert video
    └── early.mp4      # Early warning video
```

## City Names

Use Hebrew city names as they appear in the official Israeli alert system. Common examples:
- `"רעננה"` (Ra'anana)
- `"תל אביב"` (Tel Aviv)
- `"ירושלים"` (Jerusalem)
- `"חיפה"` (Haifa)
- `"באר שבע"` (Be'er Sheva)

## Usage

Once installed and configured, the plugin will:

1. **Primary Alert Monitoring**: Continuously monitor WebSocket for immediate threats
2. **Early Warning Monitoring**: Poll OREF API every 8 seconds for advance notifications
3. **HomeKit Integration**: 
   - Create primary alert contact sensor
   - Create early warning contact sensor  
   - Create test switch for manual testing
4. **Alert Response**:
   - Activate appropriate contact sensor
   - Play media on all discovered Chromecast devices
   - Respect priority system (primary alerts interrupt early warnings)
   - Apply volume settings based on alert type

## Volume Configuration Examples

### Simple Configuration
```json
{
    "chromecastVolume": 50
}
```
All devices play at 50% volume for primary alerts, 30% for early warnings.

### Per-Device Configuration
```json
{
    "chromecastVolume": 100,
    "chromecastVolumes": [
        {
            "deviceName": "Living Room TV",
            "volume": 60
        },
        {
            "deviceName": "Bedroom TV",
            "volume": 30
        }
    ],
    "earlyWarningVolumeReduction": 25
}
```
- Living Room TV: 60% primary, 35% early warning
- Bedroom TV: 30% primary, 5% early warning
- Other devices: 100% primary, 75% early warning

## Troubleshooting

### Primary Alerts
- **No primary alerts received**: Verify WebSocket connection and city names
- **Connection issues**: Check network connectivity and firewall settings

### Early Warnings
- **No early warnings**: Verify OREF API access and city names in Hebrew
- **Duplicate alerts**: Plugin automatically prevents replaying same alerts within 60 seconds
- **Time restrictions**: Early warnings only play during configured hours (10 AM - 8 PM default)

### Chromecast Issues
- **Devices not detected**: Ensure Chromecast devices are on same network as Homebridge
- **Media not playing**: Check media files exist and media server is accessible
- **Volume issues**: Verify per-device volume configuration syntax

### General Issues
- **Plugin not loading**: Check Homebridge logs for configuration errors
- **Memory usage**: Plugin automatically cleans up old processed alerts

## API Endpoints

The plugin creates a local media server with the following endpoints:

- `GET /alert-video` - Primary alert video
- `GET /test-video` - Test alert video  
- `GET /early-warning-video` - Early warning video
- `GET /alert-sound` - Primary alert audio
- `GET /test-sound` - Test alert audio
- `GET /early-warning-sound` - Early warning audio
- `GET /health` - Health check endpoint

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Disclaimer

This plugin is designed to complement, not replace, official alert systems. Always follow official guidance from Israeli emergency services and authorities.
