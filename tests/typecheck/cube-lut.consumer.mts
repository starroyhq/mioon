import {parseCube3D, sampleCube3D, canonicalCube3D, CUBE_3D_PROFILE} from '../../packages/business/src/cube-lut.ts';
import type {Cube3D, Cube3DMetadata, CubeRgb} from '../../packages/business/src/cube-lut.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type ParsedExact = Expect<Equal<ReturnType<typeof parseCube3D>, Cube3D>>;
type RgbExact = Expect<Equal<ReturnType<typeof sampleCube3D>, CubeRgb>>;
type MetadataChecked = Expect<NotAny<Cube3DMetadata>>;
type ProfileExact = Expect<Equal<typeof CUBE_3D_PROFILE, 'mioon-cube3d-normalized-tetrahedral-v1'>>;
type MetadataKeys = Expect<Equal<keyof Cube3DMetadata,
  'profileId' | 'size' | 'title' | 'domainMin' | 'domainMax' | 'rowCount' | 'rowOrder' | 'interpolation' | 'numericPrecision'>>;

export function consume(cube: Cube3D): string {
  const output: CubeRgb = sampleCube3D(cube, [0.1, 0.5, 0.9], 0.5);
  // @ts-expect-error A parsed table cannot be manufactured from metadata.
  const fake: Cube3D = {metadata: cube.metadata};
  // @ts-expect-error Metadata cannot be mutated after validation.
  cube.metadata.size = 999;
  // @ts-expect-error The unit domain is fixed and readonly.
  cube.metadata.domainMin[0] = -1;
  // @ts-expect-error Sampling does not return mutable output storage.
  output[0] = 1;
  // @ts-expect-error Only a normalized RGB triplet is accepted, not RGBA.
  sampleCube3D(cube, [0, 0, 0, 1]);
  // @ts-expect-error Parsing accepts text, never a filename option or loader.
  parseCube3D({path: 'look.cube'});
  // @ts-expect-error This profile does not permit interchangeable interpolation.
  const interpolation: Cube3DMetadata['interpolation'] = 'trilinear';
  void [fake, interpolation];
  return canonicalCube3D(cube);
}
