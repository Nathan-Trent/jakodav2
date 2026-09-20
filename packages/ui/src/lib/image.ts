/** Shrink a photo to ≤1600px on the long side as JPEG — enough to read handwriting, small enough to send. */
export function downscaleImage(file: File, max = 1600): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const g = canvas.getContext("2d");
      if (!g) { URL.revokeObjectURL(url); reject(new Error("Could not read the image")); return; }
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(url);
      resolve({ base64: dataUrl.split(",")[1] ?? "", dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image we can read")); };
    img.src = url;
  });
}
