"""Verify and prepare local footage and the Blender plate for the Cappy film."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def run(*arguments):
    subprocess.run(arguments, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", required=True, type=Path, help="Directory containing capture-ID folders")
    parser.add_argument("--blender", default="blender")
    parser.add_argument("--skip-blender", action="store_true", help="Use an already rendered 90-frame plate")
    args = parser.parse_args()
    project = Path(__file__).resolve().parent
    repo = project.parents[1]
    sources = json.loads((project / "SOURCES.json").read_text())
    capture = args.captures / sources["captureId"]
    for item in sources["assets"]:
        source = capture / ("delivery.mp4" if item["role"] == "delivery" else "knockdown.mp4")
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if actual != item["sha256"]:
            raise ValueError(f"Source hash mismatch for {item['role']}")
        destination = project / "assets" / ("capture.mp4" if item["role"] == "delivery" else "knockdown.mp4")
        start = "1.75" if item["role"] == "delivery" else "0"
        run("ffmpeg", "-v", "error", "-y", "-ss", start, "-i", str(source), "-t", "3", "-an", "-r", "30",
            "-c:v", "libx264", "-crf", "18", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(destination))
    if not args.skip_blender:
        run(args.blender, "-b", "-P", str(repo / "scripts/brand/glass-logo.py"), "--", "--plate", "--size", "900", "--samples", "16")
    run("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x160d22:s=900x900:r=30:d=3",
        "-framerate", "30", "-i", str(repo / "artifacts/brand/frames/glass-%04d.png"), "-filter_complex",
        "[0:v][1:v]overlay=shortest=1:format=rgb,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]",
        "-map", "[v]", "-an", "-c:v", "libx264",
        "-crf", "15", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-movflags", "+faststart", str(project / "assets/glass-plate.mp4"))
    print("Sources verified and all three silent media clips prepared.")


if __name__ == "__main__":
    main()
