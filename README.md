# VR Flood Simulator

WebXR-based flood simulation with real-world terrain data. Features physics-based water flow, interactive storms, and VR support for Meta Quest 3.

![VR Flood Simulator](https://img.shields.io/badge/WebXR-VR%20Ready-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🌊 **Physics-based water simulation** - Pipe-model flux-based shallow water equations with realistic flow dynamics
- 🗺️ **Real-world terrain** - Fetch SRTM elevation data for any location worldwide
- 🥽 **VR Support** - Full WebXR implementation for Meta Quest 3 and other VR headsets
- ⛈️ **Interactive storms** - Place local storms or trigger regional rain with adjustable intensity (0-500+ mm/hr)
- 📊 **Multiple scales** - Presets from human-scale (250m) to regional (75km radius)
- ⚡ **Real-time performance** - Optimized simulation with configurable speed (up to 100x)
- 🎨 **Terrain visualization** - Elevation-based coloring with optional OpenStreetMap overlay

## Technology Stack

- **Frontend**: Three.js, WebXR API
- **Physics**: Custom shallow water equation solver (JavaScript)
- **Data Pipeline**: Python (SRTM/GDAL, trimesh, rasterio)
- **Server**: Python HTTPS server

## Prerequisites

- Python 3.8+
- Modern web browser with WebXR support (or Meta Quest 3)
- Internet connection for terrain data download

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/reality2-roycdavies/flood-sim.git
cd flood-sim
```

### 2. Install Python dependencies

```bash
pip install -r pipeline/requirements.txt
```

Required packages:
- `numpy` - Numerical computations
- `scipy` - Image resampling
- `rasterio` - GeoTIFF processing
- `trimesh` - 3D mesh generation
- `geopy` - Geocoding (optional, for place name lookup)
- `Pillow` - OSM overlay generation (optional)

### 3. Generate SSL certificates

WebXR requires HTTPS. Generate self-signed certificates for local development:

```bash
./generate-cert.sh
```

This creates `cert.pem` and `key.pem` (ignored by git).

### 4. Fetch terrain data

Download elevation data for your desired location:

```bash
# By place name
python3 pipeline/fetch_terrain.py --place "Wairoa, New Zealand" --scale township

# By coordinates
python3 pipeline/fetch_terrain.py --lat -39.05 --lon 177.41 --scale township

# Custom bounds (south,west,north,east)
python3 pipeline/fetch_terrain.py --bounds "-39.07,177.38,-39.03,177.44"

# With OpenStreetMap overlay
python3 pipeline/fetch_terrain.py --place "Your City" --scale township --overlay
```

**Scale presets:**
- `human` - 250m radius, 256x256 grid (neighborhood/park scale)
- `neighbourhood` - 1km radius, 256x256 grid
- `township` - 3km radius, 256x256 grid (default, good for small towns)
- `catchment` - 25km radius, 256x256 grid (river catchment)
- `regional` - 75km radius, 128x128 grid (large region)

This will create:
- `data/terrain.glb` - 3D terrain mesh
- `data/heightmap.bin` - Binary heightmap for physics
- `data/heightmap_meta.json` - Metadata (bounds, cell size, etc.)
- `data/overlay.png` - Optional map overlay (with `--overlay` flag)

### 5. Start the server

```bash
python3 server.py
```

The server will display URLs like:
```
Local:   https://localhost:8443
Network: https://192.168.1.100:8443
```

### 6. Open in browser

**Desktop:**
- Open the Local URL in your browser
- Accept the self-signed certificate warning

**Meta Quest 3:**
- Open the Network URL in Quest Browser
- Accept the certificate warning
- Enter VR mode using the VR button

## Usage

### Controls

**Desktop:**
- **Mouse drag** - Rotate camera
- **Mouse wheel** - Zoom in/out
- **Click terrain** - Place local storm
- **+/-** - Increase/decrease rain intensity
- **[/]** - Decrease/increase simulation speed
- **Tab** - Toggle camera view modes
- **B** - Reset water simulation
- **Space** - Toggle rain on/off

**VR (Quest 3):**
- **A button** - Toggle rain on/off
- **B button** - Reset water
- **Trigger + point** - Place local storm
- **Thumbstick** - Move around terrain

### Rain Intensity Scale

The simulator shows human-readable rain classifications:
- **0 mm/hr** - Off
- **1-3 mm/hr** - Drizzle
- **3-10 mm/hr** - Light rain
- **10-25 mm/hr** - Moderate rain
- **25-50 mm/hr** - Heavy rain
- **50-100 mm/hr** - Intense rain
- **100-250 mm/hr** - Severe (flash flood conditions)
- **250+ mm/hr** - Extreme (catastrophic)

### HUD Information

- **Rain** - Current rainfall rate and mode (Regional/Local)
- **Max Depth** - Maximum water depth anywhere in the simulation
- **Sim Time** - Simulated time elapsed (minutes/hours at current speed multiplier)

## How It Works

### Physics Simulation

The water simulation uses a **pipe-model flux-based approach** to solve shallow water equations:

1. **Flux calculation** - Compute water flow between cells based on height differences
2. **Conservation** - Update water levels based on net flux (inflow - outflow)
3. **Edge drainage** - Water flows off edges at configurable rate (simulates drainage to ocean/aquifers)
4. **Ground absorption** - Soil infiltration (~2mm/hr by default)

Key parameters (see `js/config.js`):
- Time step: 0.02s (50 Hz physics)
- Gravity: 9.81 m/s²
- Flow multiplier: Tuned for visible flow at 20-30m cell resolution
- Edge drain rate: 2.0 (fraction per second)

### Warmup Phase

Before the user starts, the simulation runs a warmup phase to create realistic initial conditions:

1. **Phase 1 (100s sim time)**: Heavy rain with low edge drainage - fills valleys and depressions
2. **Phase 2 (60s sim time)**: No rain, normal drainage - excess water drains, leaving natural rivers/pools

This creates a more realistic starting state where water has already collected in natural drainage patterns.

### Terrain Pipeline

The Python pipeline (`pipeline/fetch_terrain.py`) handles terrain data acquisition:

1. **Geocoding** - Convert place names to coordinates (optional)
2. **SRTM download** - Fetch 30m resolution elevation data from AWS
3. **Processing** - Clip to bounds, resample to target grid size
4. **Vertical exaggeration** - Auto-calculated based on relief (1.0x to 5.0x)
5. **Mesh generation** - Create textured 3D mesh with elevation-based colors
6. **Export** - Generate GLB mesh and binary heightmap

## Project Structure

```
flood-sim/
├── index.html              # Main HTML entry point
├── server.py               # HTTPS development server
├── generate-cert.sh        # SSL certificate generator
├── css/
│   └── style.css          # UI styling
├── js/
│   ├── main.js            # Main application loop
│   ├── water-sim.js       # Physics simulation
│   ├── water-mesh.js      # Water surface rendering
│   ├── storm.js           # Storm/rain management
│   ├── terrain-loader.js  # Terrain data loading
│   ├── controls.js        # Camera controls
│   ├── vr-setup.js        # WebXR initialization
│   ├── input.js           # Input handling
│   └── config.js          # Configuration constants
├── pipeline/
│   ├── fetch_terrain.py   # Terrain data pipeline
│   └── requirements.txt   # Python dependencies
└── data/                  # Generated terrain data (git-ignored)
    ├── terrain.glb
    ├── heightmap.bin
    ├── heightmap_meta.json
    └── overlay.png
```

## Advanced Usage

### Custom DEM Input

If you have your own GeoTIFF elevation data:

```bash
python3 pipeline/fetch_terrain.py --input-tif /path/to/your/dem.tif --grid-size 256
```

### Visualization Options

```bash
# Show matplotlib preview of heightmap
python3 pipeline/fetch_terrain.py --place "Your Location" --scale township --plot

# Custom vertical exaggeration
python3 pipeline/fetch_terrain.py --place "Your Location" --vert-exag 3.0
```

### Tuning Physics

Edit `js/config.js` to adjust simulation parameters:
- `SIM_DT` - Time step (lower = more stable, slower)
- `SIM_GRAVITY` - Gravitational constant
- `SIM_FLOW_MULTIPLIER` - Flow rate multiplier (higher = faster flow)
- `SIM_SPEED_MIN/MAX` - Speed multiplier bounds

## Troubleshooting

**"Failed to load terrain" error:**
- Make sure you've run the terrain pipeline first
- Check that `data/terrain.glb` and `data/heightmap.bin` exist

**Certificate warning on Quest:**
- This is normal for self-signed certificates
- Click "Advanced" → "Proceed to site" (exact wording varies)

**VR button not appearing:**
- Ensure you're using HTTPS (not HTTP)
- WebXR requires a secure context
- Some browsers need VR hardware connected to show the button

**Slow performance:**
- Try a smaller scale preset or lower `--grid-size`
- Reduce simulation speed with `[` key
- Close other browser tabs

**Python dependencies fail to install:**
- GDAL/rasterio can be tricky - try: `pip install --no-binary rasterio rasterio`
- On Linux: `sudo apt-get install gdal-bin libgdal-dev`
- On macOS: `brew install gdal`

## Contributing

Contributions are welcome! Areas for improvement:
- Mobile/touch controls
- More sophisticated storm patterns (fronts, cells)
- Evaporation modeling
- Sediment transport
- Multi-resolution grids for larger areas
- Save/load simulation states

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Elevation data from NASA SRTM
- Map tiles from OpenStreetMap contributors
- Built with Three.js and WebXR API

## Contact

Created by [@reality2-roycdavies](https://github.com/reality2-roycdavies)

---

**Note**: This is an educational/visualization tool. For actual flood risk assessment, consult professional hydrological models and local authorities.
