import * as THREE from 'three';

export function fitTextureToFrame(mesh, texture, frameWidth, frameHeight) {
  // Get dimensions of the loaded image
  const imageWidth = texture.image.width;
  const imageHeight = texture.image.height;

  // Calculate ratios
  const frameRatio = frameWidth / frameHeight;
  const imageRatio = imageWidth / imageHeight;

  if (imageRatio > frameRatio) {
    // Image is wider than the frame -> Fit to width, scale down height
    mesh.scale.set(1, (frameWidth / imageRatio) / frameHeight, 1);
  } else {
    // Image is taller than the frame -> Fit to height, scale down width
    mesh.scale.set((frameHeight * imageRatio) / frameWidth, 1, 1);
  }
}

