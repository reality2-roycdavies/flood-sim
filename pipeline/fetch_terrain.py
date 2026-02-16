#!/usr/bin/env python3
"""
Fetch SRTM elevation data for any location and export terrain mesh + heightmap.

Usage:
  python fetch_terrain.py --lat -39.05 --lon 177.41 --scale township
  python fetch_terrain.py --place "Wairoa, New Zealand" --scale township
  python fetch_terrain.py --bounds "-39.07,177.38,-39.03,177.44"
  python fetch_terrain.py --input-tif path/to/dem.tif --grid-size 256
"""

import argparse
import json
import os
import struct
import sys
import tempfile

import numpy as np
from scipy.ndimage import zoom


# Scale presets: name -> (radius_km, grid_size, default_vert_exag)
SCALE_PRESETS = {
    'human':         (0.25, 256, None),
    'neighbourhood': (1.0,  256, None),
    'township':      (3.0,  256, None),
    'catchment':     (25.0, 256, None),
    'regional':      (75.0, 128, None),
}


def geocode_place(place_name):
    """Geocode a place name to (lat, lon) using geopy."""
    from geopy.geocoders import Nominatim
    geolocator = Nominatim(user_agent="flood-sim-pipeline")
    location = geolocator.geocode(place_name)
    if location is None:
        raise ValueError(f"Could not geocode: {place_name}")
    print(f"  Geocoded '{place_name}' -> ({location.latitude:.4f}, {location.longitude:.4f})")
    return location.latitude, location.longitude


def compute_bounds(lat, lon, radius_km):
    """Compute bounding box from center + radius in km."""
    # Approximate degrees per km
    lat_deg_per_km = 1.0 / 111.0
    lon_deg_per_km = 1.0 / (111.0 * np.cos(np.radians(lat)))

    dlat = radius_km * lat_deg_per_km
    dlon = radius_km * lon_deg_per_km

    return (lat - dlat, lon - dlon, lat + dlat, lon + dlon)


def get_srtm_tile_names(bounds):
    """Get list of SRTM tile names needed to cover bounds."""
    south, west, north, east = bounds
    import math
    tiles = []
    for lat in range(math.floor(south), math.floor(north) + 1):
        for lon in range(math.floor(west), math.floor(east) + 1):
            lat_prefix = 'N' if lat >= 0 else 'S'
            lon_prefix = 'E' if lon >= 0 else 'W'
            tile = f"{lat_prefix}{abs(lat):02d}{lon_prefix}{abs(lon):03d}"
            tiles.append((tile, lat, lon))
    return tiles


def fetch_srtm_tiles(bounds, cache_dir=None):
    """Fetch SRTM tiles directly via HTTP, return list of local .tif/.hgt paths.

    Checks multiple cache locations and download sources:
    1. elevation package cache (~/.cache/elevation/SRTM1/cache/)
    2. Our own cache dir
    3. Downloads from AWS S3 elevation-tiles-prod
    """
    import gzip
    import urllib.request

    if cache_dir is None:
        cache_dir = os.path.join(os.path.expanduser('~'), '.cache', 'flood-sim', 'srtm')
    os.makedirs(cache_dir, exist_ok=True)

    # Also check elevation package's cache
    elevation_cache = os.path.join(os.path.expanduser('~'), '.cache', 'elevation', 'SRTM1', 'cache')

    tiles = get_srtm_tile_names(bounds)
    paths = []

    for tile_name, lat, lon in tiles:
        lat_dir = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"

        # Check elevation package cache first
        elev_cached = os.path.join(elevation_cache, lat_dir, f"{tile_name}.tif")
        if os.path.exists(elev_cached) and os.path.getsize(elev_cached) > 0:
            print(f"  Found cached tile: {elev_cached}")
            paths.append(elev_cached)
            continue

        # Check our cache
        our_cached = os.path.join(cache_dir, f"{tile_name}.hgt")
        if os.path.exists(our_cached) and os.path.getsize(our_cached) > 0:
            print(f"  Found cached tile: {our_cached}")
            paths.append(our_cached)
            continue

        # Download from AWS
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/skadi/{lat_dir}/{tile_name}.hgt.gz"
        gz_path = os.path.join(cache_dir, f"{tile_name}.hgt.gz")
        hgt_path = os.path.join(cache_dir, f"{tile_name}.hgt")

        print(f"  Downloading {tile_name} from {url}...")
        try:
            urllib.request.urlretrieve(url, gz_path)
            # Decompress
            with gzip.open(gz_path, 'rb') as f_in:
                with open(hgt_path, 'wb') as f_out:
                    f_out.write(f_in.read())
            os.remove(gz_path)
            print(f"  Saved: {hgt_path}")
            paths.append(hgt_path)
        except Exception as e:
            print(f"  WARNING: Failed to download {tile_name}: {e}")

    return paths


def load_srtm_tiles(tile_paths, bounds, grid_size):
    """Load and merge SRTM tiles, clip to bounds, resample to grid_size."""
    import rasterio
    from rasterio.windows import from_bounds

    if len(tile_paths) == 1:
        # Single tile - simple path
        return load_and_resample(tile_paths[0], bounds, grid_size)

    # Multiple tiles - merge them
    from rasterio.merge import merge
    datasets = [rasterio.open(p) for p in tile_paths]
    merged, merged_transform = merge(datasets)
    for ds in datasets:
        ds.close()

    data = merged[0]  # first band

    # Clip to bounds
    south, west, north, east = bounds
    # Convert bounds to pixel coordinates using the merged transform
    inv_transform = ~merged_transform
    col_min, row_min = inv_transform * (west, north)
    col_max, row_max = inv_transform * (east, south)
    col_min, col_max = int(max(0, col_min)), int(min(data.shape[1], col_max))
    row_min, row_max = int(max(0, row_min)), int(min(data.shape[0], row_max))
    data = data[row_min:row_max, col_min:col_max]

    # Handle nodata
    mask_bad = data <= -1000
    if mask_bad.any():
        valid = data[~mask_bad]
        data[mask_bad] = valid.min() if len(valid) > 0 else 0

    # Resample
    if data.shape[0] != grid_size or data.shape[1] != grid_size:
        zoom_y = grid_size / data.shape[0]
        zoom_x = grid_size / data.shape[1]
        data = zoom(data, (zoom_y, zoom_x), order=3)

    return data.astype(np.float32), bounds


def load_and_resample(tif_path, bounds, grid_size):
    """Load GeoTIFF, clip to bounds, resample to grid_size x grid_size."""
    import rasterio
    from rasterio.windows import from_bounds

    with rasterio.open(tif_path) as src:
        if bounds is not None:
            south, west, north, east = bounds
            window = from_bounds(west, south, east, north, src.transform)
            data = src.read(1, window=window)
        else:
            data = src.read(1)

        # Handle nodata
        nodata = src.nodata
        if nodata is not None:
            mask = data == nodata
            if mask.any():
                valid = data[~mask]
                if len(valid) > 0:
                    data[mask] = valid.min()
                else:
                    data[mask] = 0

        # Also handle SRTM typical nodata of -32768
        mask_srtm = data <= -1000
        if mask_srtm.any():
            valid = data[~mask_srtm]
            if len(valid) > 0:
                data[mask_srtm] = valid.min()
            else:
                data[mask_srtm] = 0

        # Resample to target grid size
        if data.shape[0] != grid_size or data.shape[1] != grid_size:
            zoom_y = grid_size / data.shape[0]
            zoom_x = grid_size / data.shape[1]
            data = zoom(data, (zoom_y, zoom_x), order=3)

        # Get transform info for cell size calculation
        if bounds is not None:
            south, west, north, east = bounds
        else:
            b = src.bounds
            south, west, north, east = b.bottom, b.left, b.top, b.right

    return data.astype(np.float32), (south, west, north, east)


def compute_vertical_exaggeration(elev_data):
    """Auto-calculate vertical exaggeration based on relief range."""
    elev_range = float(elev_data.max() - elev_data.min())
    if elev_range < 10:
        return 5.0
    elif elev_range < 50:
        return 3.0
    elif elev_range < 200:
        return 2.0
    elif elev_range < 500:
        return 1.5
    else:
        return 1.0


def fetch_osm_overlay(bounds, output_path, tile_size=256):
    """Download OpenStreetMap tiles for the bounding box and composite into a single image."""
    import math
    import urllib.request
    from PIL import Image

    south, west, north, east = bounds

    # Pick zoom level: aim for ~1024px across the longer dimension
    lat_span = north - south
    lon_span = east - west
    span = max(lat_span, lon_span)
    # At zoom z, the world is 256 * 2^z pixels wide (360 degrees)
    # We want span_degrees * (256 * 2^z / 360) ~ 1024 pixels
    target_px = 1024
    z = int(round(math.log2(target_px * 360 / (span * 256))))
    z = max(1, min(z, 18))

    def lat_lon_to_tile(lat, lon, zoom):
        n = 2 ** zoom
        x = int((lon + 180) / 360 * n)
        lat_rad = math.radians(lat)
        y = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
        return x, y

    def tile_to_lat_lon(x, y, zoom):
        n = 2 ** zoom
        lon = x / n * 360 - 180
        lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
        lat = math.degrees(lat_rad)
        return lat, lon

    # Get tile range
    x_min, y_min = lat_lon_to_tile(north, west, z)
    x_max, y_max = lat_lon_to_tile(south, east, z)

    cols = x_max - x_min + 1
    rows = y_max - y_min + 1
    print(f"  OSM tiles: zoom={z}, {cols}x{rows} tiles ({cols * rows} total)")

    # Download and composite
    composite = Image.new('RGB', (cols * tile_size, rows * tile_size))

    headers = {'User-Agent': 'flood-sim-pipeline/1.0 (educational project)'}

    for ty in range(y_min, y_max + 1):
        for tx in range(x_min, x_max + 1):
            url = f"https://tile.openstreetmap.org/{z}/{tx}/{ty}.png"
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req) as resp:
                    tile_data = resp.read()
                tile_img = Image.open(__import__('io').BytesIO(tile_data))
                px = (tx - x_min) * tile_size
                py = (ty - y_min) * tile_size
                composite.paste(tile_img, (px, py))
            except Exception as e:
                print(f"  WARNING: Failed to fetch tile {z}/{tx}/{ty}: {e}")

    # Crop to exact bounds
    nw_lat, nw_lon = tile_to_lat_lon(x_min, y_min, z)
    se_lat, se_lon = tile_to_lat_lon(x_max + 1, y_max + 1, z)

    total_w = composite.width
    total_h = composite.height

    # Pixel coords of our bounds within the composite
    px_left = int((west - nw_lon) / (se_lon - nw_lon) * total_w)
    px_right = int((east - nw_lon) / (se_lon - nw_lon) * total_w)
    px_top = int((nw_lat - north) / (nw_lat - se_lat) * total_h)
    px_bottom = int((nw_lat - south) / (nw_lat - se_lat) * total_h)

    px_left = max(0, px_left)
    px_top = max(0, px_top)
    px_right = min(total_w, px_right)
    px_bottom = min(total_h, px_bottom)

    cropped = composite.crop((px_left, px_top, px_right, px_bottom))
    # Resize to power-of-two for GPU texture
    cropped = cropped.resize((1024, 1024), Image.LANCZOS)

    # Boost contrast — OSM tiles are very pastel
    from PIL import ImageEnhance
    cropped = ImageEnhance.Contrast(cropped).enhance(1.6)
    cropped = ImageEnhance.Color(cropped).enhance(1.3)

    cropped.save(output_path)
    print(f"  Exported overlay: {output_path} (1024x1024)")


def elevation_to_color(elev):
    """Map elevation to RGB color (0-1 range).
    High contrast palette for readability against dark sky."""
    if elev < 0:
        return (0.18, 0.25, 0.38)  # dark blue-grey (water/coast)
    elif elev < 5:
        # Beach / river flats — sandy
        t = max(0, elev / 5.0)
        return (
            0.55 + t * 0.05,
            0.52 + t * 0.03,
            0.35 + t * 0.02,
        )
    elif elev < 30:
        # Low floodplain — rich green
        t = (elev - 5) / 25.0
        return (
            0.15 + t * 0.05,
            0.45 + t * 0.15,
            0.10 + t * 0.05,
        )
    elif elev < 80:
        # Low hills — green to yellow-green
        t = (elev - 30) / 50.0
        return (
            0.20 + t * 0.30,
            0.60 + t * (-0.05),
            0.15 + t * 0.05,
        )
    elif elev < 200:
        # Mid hills — yellow-green to tan
        t = (elev - 80) / 120.0
        return (
            0.50 + t * 0.25,
            0.55 + t * (-0.15),
            0.20 + t * 0.12,
        )
    elif elev < 500:
        # High hills — tan to brown
        t = (elev - 200) / 300.0
        return (
            0.75 + t * (-0.20),
            0.40 + t * (-0.10),
            0.32 + t * (-0.02),
        )
    else:
        # Mountain — grey to white
        t = min((elev - 500) / 1000.0, 1.0)
        return (
            0.55 + t * 0.40,
            0.52 + t * 0.43,
            0.50 + t * 0.45,
        )


def build_mesh(elev_data, grid_size, cell_size_m, vert_exag):
    """Build a trimesh mesh with elevation-based vertex colors."""
    import trimesh

    rows, cols = elev_data.shape
    elev_min = float(elev_data.min())

    # Center the mesh at origin
    half_x = (cols - 1) * cell_size_m / 2.0
    half_z = (rows - 1) * cell_size_m / 2.0

    # Build vertices
    vertices = []
    colors = []
    for r in range(rows):
        for c in range(cols):
            x = c * cell_size_m - half_x
            y = (elev_data[r, c] - elev_min) * vert_exag
            z = r * cell_size_m - half_z
            vertices.append([x, y, z])

            rgb = elevation_to_color(elev_data[r, c])
            colors.append([int(rgb[0]*255), int(rgb[1]*255), int(rgb[2]*255), 255])

    vertices = np.array(vertices, dtype=np.float64)
    colors = np.array(colors, dtype=np.uint8)

    # Build faces (two triangles per quad)
    faces = []
    for r in range(rows - 1):
        for c in range(cols - 1):
            i00 = r * cols + c
            i10 = (r + 1) * cols + c
            i01 = r * cols + (c + 1)
            i11 = (r + 1) * cols + (c + 1)
            faces.append([i00, i10, i01])
            faces.append([i01, i10, i11])

    faces = np.array(faces, dtype=np.int64)

    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=faces,
        vertex_colors=colors,
        process=False,
    )

    return mesh


def export_heightmap(elev_data, vert_exag, elev_min, output_path):
    """Export heightmap as raw Float32 binary (row-major, little-endian).
    Values are in scene coordinates (elevation - min) * vert_exag."""
    scene_heights = ((elev_data - elev_min) * vert_exag).astype(np.float32)
    scene_heights.tofile(output_path)
    print(f"  Exported heightmap: {output_path} ({scene_heights.shape})")
    return scene_heights


def main():
    parser = argparse.ArgumentParser(description='Fetch SRTM terrain data for flood simulation')
    parser.add_argument('--lat', type=float, help='Center latitude')
    parser.add_argument('--lon', type=float, help='Center longitude')
    parser.add_argument('--place', type=str, help='Place name to geocode')
    parser.add_argument('--bounds', type=str, help='Bounding box: "south,west,north,east"')
    parser.add_argument('--scale', type=str, default='township',
                        choices=SCALE_PRESETS.keys(), help='Scale preset')
    parser.add_argument('--grid-size', type=int, default=None, help='Override grid size')
    parser.add_argument('--vert-exag', type=float, default=None, help='Override vertical exaggeration')
    parser.add_argument('--input-tif', type=str, help='Use existing GeoTIFF instead of fetching SRTM')
    parser.add_argument('--output-dir', type=str, default=None, help='Output directory (default: ../data)')
    parser.add_argument('--overlay', action='store_true', help='Fetch OSM map overlay (roads, labels)')
    parser.add_argument('--plot', action='store_true', help='Show matplotlib plot of heightmap')

    args = parser.parse_args()

    # Determine output directory
    output_dir = args.output_dir
    if output_dir is None:
        output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    os.makedirs(output_dir, exist_ok=True)

    # Resolve location
    location_name = None
    if args.place:
        lat, lon = geocode_place(args.place)
        location_name = args.place
    elif args.lat is not None and args.lon is not None:
        lat, lon = args.lat, args.lon
        location_name = f"{lat:.4f}, {lon:.4f}"
    elif args.bounds:
        parts = [float(x) for x in args.bounds.split(',')]
        lat = (parts[0] + parts[2]) / 2
        lon = (parts[1] + parts[3]) / 2
        location_name = f"Custom bounds"
    elif args.input_tif:
        lat, lon = 0, 0  # Will be overridden
        location_name = os.path.basename(args.input_tif)
    else:
        parser.error('Provide --lat/--lon, --place, --bounds, or --input-tif')

    # Get scale preset
    radius_km, default_grid, _ = SCALE_PRESETS[args.scale]
    grid_size = args.grid_size or default_grid

    print(f"\n  VR Flood Simulator - Terrain Pipeline")
    print(f"  ======================================")
    print(f"  Location: {location_name}")
    print(f"  Scale: {args.scale} ({radius_km}km radius)")
    print(f"  Grid: {grid_size}x{grid_size}")

    # Compute bounds
    if args.bounds:
        parts = [float(x) for x in args.bounds.split(',')]
        bounds = (parts[0], parts[1], parts[2], parts[3])
    elif args.input_tif:
        bounds = None  # Use full TIF extent
    else:
        bounds = compute_bounds(lat, lon, radius_km)

    if bounds:
        print(f"  Bounds: S={bounds[0]:.4f} W={bounds[1]:.4f} N={bounds[2]:.4f} E={bounds[3]:.4f}")

    # Get elevation data
    if args.input_tif:
        print(f"\n  Loading: {args.input_tif}")
        elev_data, actual_bounds = load_and_resample(args.input_tif, bounds, grid_size)
    else:
        # Fetch SRTM tiles directly (no GDAL CLI needed)
        print(f"\n  Fetching SRTM tiles...")
        try:
            tile_paths = fetch_srtm_tiles(bounds)
            if not tile_paths:
                raise RuntimeError("No SRTM tiles found or downloaded")
            elev_data, actual_bounds = load_srtm_tiles(tile_paths, bounds, grid_size)
        except Exception as e:
            print(f"\n  ERROR: SRTM fetch failed: {e}")
            print(f"  Try: --input-tif with a manually downloaded DEM")
            sys.exit(1)

    south, west, north, east = actual_bounds if bounds is None else bounds
    center_lat = (south + north) / 2
    center_lon = (west + east) / 2

    # Calculate cell size in meters
    lat_extent_m = (north - south) * 111000
    lon_extent_m = (east - west) * 111000 * np.cos(np.radians(center_lat))
    cell_size_m = max(lat_extent_m, lon_extent_m) / grid_size

    print(f"\n  Elevation range: {elev_data.min():.1f}m - {elev_data.max():.1f}m")
    print(f"  Cell size: {cell_size_m:.1f}m")

    # Vertical exaggeration
    vert_exag = args.vert_exag or compute_vertical_exaggeration(elev_data)
    print(f"  Vertical exaggeration: {vert_exag:.1f}x")

    # Export heightmap binary
    elev_min = float(elev_data.min())
    elev_max = float(elev_data.max())
    heightmap_path = os.path.join(output_dir, 'heightmap.bin')
    export_heightmap(elev_data, vert_exag, elev_min, heightmap_path)

    # Export metadata
    meta = {
        'grid_size': grid_size,
        'cell_size_m': round(cell_size_m, 3),
        'bounds': {
            'south': round(south, 6),
            'west': round(west, 6),
            'north': round(north, 6),
            'east': round(east, 6),
        },
        'elev_min': round(elev_min, 2),
        'elev_max': round(elev_max, 2),
        'vertical_exaggeration': round(vert_exag, 2),
        'center_lat': round(center_lat, 6),
        'center_lon': round(center_lon, 6),
        'location_name': location_name,
        'scale': args.scale,
    }
    meta_path = os.path.join(output_dir, 'heightmap_meta.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f"  Exported metadata: {meta_path}")

    # Build and export mesh
    print(f"\n  Building terrain mesh...")
    mesh = build_mesh(elev_data, grid_size, cell_size_m, vert_exag)
    glb_path = os.path.join(output_dir, 'terrain.glb')
    mesh.export(glb_path)
    print(f"  Exported mesh: {glb_path} ({len(mesh.vertices)} vertices, {len(mesh.faces)} faces)")

    # OSM overlay
    if args.overlay:
        print(f"\n  Fetching OSM overlay...")
        overlay_path = os.path.join(output_dir, 'overlay.png')
        try:
            fetch_osm_overlay(bounds, overlay_path)
            meta['has_overlay'] = True
            # Re-write meta with overlay flag
            with open(meta_path, 'w') as f:
                json.dump(meta, f, indent=2)
        except Exception as e:
            print(f"  WARNING: Overlay fetch failed: {e}")
            print(f"  pip install Pillow if missing")

    # Optional plot
    if args.plot:
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(1, 2, figsize=(14, 6))
        im1 = axes[0].imshow(elev_data, cmap='terrain', origin='upper')
        axes[0].set_title(f'Elevation ({location_name})')
        plt.colorbar(im1, ax=axes[0], label='meters')
        # Scene heights
        scene_heights = (elev_data - elev_min) * vert_exag
        im2 = axes[1].imshow(scene_heights, cmap='viridis', origin='upper')
        axes[1].set_title(f'Scene Heights ({vert_exag}x exag)')
        plt.colorbar(im2, ax=axes[1], label='meters')
        plt.tight_layout()
        plt.show()

    print(f"\n  Done! Files in {output_dir}/")
    print(f"  Run: python3 server.py\n")


if __name__ == '__main__':
    main()
