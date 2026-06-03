// Rasterize a face (image element, canvas, or video frame) to a JPEG data URL
// for use as a D-ID source / orb still. No baked-on halo/horns — the angel vs
// devil distinction comes from the orb's glow, color wash, and voice.
export async function decorateFace(imgSource) {
  const w = imgSource.naturalWidth || imgSource.videoWidth || imgSource.width;
  const h = imgSource.naturalHeight || imgSource.videoHeight || imgSource.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(imgSource, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.92);
}
