// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Smooth edges of the ground cover.
 *
 * The ground cover of a tile is a raster of 2 m cells, one class (meadow,
 * field, car park, water …) to a cell.  Drawn as a filtered texture its
 * edges are blurred steps of 2 m.  The map build therefore stores with each
 * cell how far its centre lies inside its class – to the nearest point of
 * another class, up to 3 m, in tenths of a metre (tools/mapgen/cover.ts,
 * the tile section `cedge`) – and the tile's cover texture carries it in its
 * alpha.
 *
 * The terrain's fragment then reads the four cells round it and, for each
 * class among them, interpolates its signed distance (+d in a cell of that
 * class, −d in another): the class with the largest value is the one the
 * point lies in, and the difference to the next is (about) the distance to
 * the edge – a straight edge comes out straight, wherever it runs through
 * the cells.  The edge is smoothed over one pixel.  Where the cells are
 * smaller than a pixel (in the distance) the plain filtered texture is used,
 * and so it is for tiles without the section (alpha 0).
 *
 * Four texel reads and a little arithmetic per pixel; nothing on the CPU
 * but the alpha byte.
 */

/** the cover texture's alpha for a stored edge byte (1 + tenths of a metre, 1 … 31; 0: none) */
export function coverEdgeAlpha(b: number): number {
  return b ? Math.min(255, b * 8) : 0;
}

/** The distance (m) an alpha of the cover texture stands for (as the shader reads it: alpha / 255 = a). */
export function coverEdgeMetres(a: number): number {
  return ((a * 255) / 8 - 1) / 10;
}

/**
 * Replaces `#include <map_fragment>` of the terrain material (which has
 * vFsWorld, materials.ts).  Defines FS_COVER_EDGE and leaves the cover's
 * colour of the pixel in fsCoverRGB (render/water.ts tells water by it).
 */
export const COVER_EDGE_GLSL = /* glsl */ `
#ifdef USE_MAP
#define FS_COVER_EDGE
vec3 fsCoverRGB;
{
  vec4 fsLin = texture2D(map, vMapUv);
  fsCoverRGB = fsLin.rgb;
  ivec2 fsN = textureSize(map, 0);
  vec2 fsP = vMapUv * vec2(fsN) - 0.5;
  vec2 fsDp = fwidth(fsP);
  float fsPx = max(fsDp.x, fsDp.y);
  vec2 fsDw = fwidth(vFsWorld.xz);
  float fsMpp = max(max(fsDw.x, fsDw.y), 1e-4);
  if (fsPx < 1.0) {
    vec2 fsI = floor(fsP);
    vec2 fsF = fsP - fsI;
    ivec2 fsI0 = ivec2(fsI);
    ivec2 fsHi = fsN - 1;
    vec4 fsT[4];
    fsT[0] = texelFetch(map, clamp(fsI0, ivec2(0), fsHi), 0);
    fsT[1] = texelFetch(map, clamp(fsI0 + ivec2(1, 0), ivec2(0), fsHi), 0);
    fsT[2] = texelFetch(map, clamp(fsI0 + ivec2(0, 1), ivec2(0), fsHi), 0);
    fsT[3] = texelFetch(map, clamp(fsI0 + ivec2(1, 1), ivec2(0), fsHi), 0);
    if (min(min(fsT[0].a, fsT[1].a), min(fsT[2].a, fsT[3].a)) > 0.01) {
      vec4 fsW = vec4((1.0 - fsF.x) * (1.0 - fsF.y), fsF.x * (1.0 - fsF.y), (1.0 - fsF.x) * fsF.y, fsF.x * fsF.y);
      vec4 fsD = vec4(fsT[0].a, fsT[1].a, fsT[2].a, fsT[3].a) * (255.0 / 80.0) - 0.1;
      // each texel's class: its signed distance interpolated here
      float fsPhi[4];
      for (int k = 0; k < 4; k++) {
        float p = 0.0;
        for (int i = 0; i < 4; i++) {
          vec3 e = fsT[i].rgb - fsT[k].rgb;
          p += fsW[i] * (dot(e, e) < 1e-7 ? fsD[i] : -fsD[i]);
        }
        fsPhi[k] = p;
      }
      int fsB = 0;
      for (int k = 1; k < 4; k++) if (fsPhi[k] > fsPhi[fsB]) fsB = k;
      vec3 fsCb = fsT[fsB].rgb;
      float fsSecond = -1e9;
      vec3 fsCs = fsCb;
      for (int k = 0; k < 4; k++) {
        vec3 e = fsT[k].rgb - fsCb;
        if (dot(e, e) >= 1e-7 && fsPhi[k] > fsSecond) {
          fsSecond = fsPhi[k];
          fsCs = fsT[k].rgb;
        }
      }
      vec3 fsSharp = fsCb;
      if (fsSecond > -1e8) {
        // (half the difference: the distance to the edge, m; smoothed over a pixel)
        float fsE = 0.5 * (fsPhi[fsB] - fsSecond);
        fsSharp = mix(fsCs, fsCb, clamp(fsE / fsMpp + 0.5, 0.5, 1.0));
      }
      fsCoverRGB = mix(fsSharp, fsLin.rgb, smoothstep(0.5, 1.0, fsPx));
    }
  }
  diffuseColor *= vec4(fsCoverRGB, 1.0);
}
#endif
`;
