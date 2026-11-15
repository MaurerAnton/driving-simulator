// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A drawn 360° panorama with a compass rose, for checking the panorama viewer
 * without any real picture (`?reality=test`): the letter in the middle of the
 * view must be the direction the car faces.
 */
export async function makeTestPanorama(lat: number, lon: number, heading: number): Promise<File> {
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) throw new Error('No 2D canvas');
  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#245fb5');
  sky.addColorStop(1, '#c4def7');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  const ground = g.createLinearGradient(0, H / 2, 0, H);
  ground.addColorStop(0, '#7d8a66');
  ground.addColorStop(1, '#3f4a36');
  g.fillStyle = ground;
  g.fillRect(0, H / 2, W, H / 2);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // the middle of the picture looks towards `heading`
  for (let d = 0; d < 360; d += 15) {
    const x = (((((d - heading + 180) % 360) + 360) % 360) / 360) * W;
    const main = d % 90 === 0;
    g.fillStyle = main ? '#ffcc00' : '#ffffff';
    g.fillRect(x - (main ? 3 : 1), H / 2 - (main ? 60 : 24), main ? 6 : 2, main ? 120 : 48);
    g.font = main ? 'bold 110px sans-serif' : '28px sans-serif';
    g.fillText(main ? 'NOSW'[d / 90] : String(d), x, H / 2 - (main ? 130 : 48));
  }
  g.fillStyle = '#ffffff';
  g.font = '34px sans-serif';
  g.fillText('Test panorama – no real picture', W / 2, H * 0.78);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not encode the test picture');
  return new File([blob], `testpano_${lat.toFixed(5)}_${lon.toFixed(5)}_h${Math.round(heading)}.jpg`, { type: 'image/jpeg' });
}
