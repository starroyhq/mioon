import {createHash} from 'node:crypto';
import {timelineColourFilterPath} from './timeline-colour-lut.ts';

export const TIMELINE_IMAGE_DISPLAY_PROFILE_ID='srgb8-to-bt1886-zero-black-display-v1' as const;
export const TIMELINE_IMAGE_RESIZE_PROFILE_ID='png-contain-bilinear-mirror-premultiplied-v1' as const;
export const TIMELINE_IMAGE_DISPLAY_TABLE_SHA256='383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c' as const;
export const TIMELINE_IMAGE_DISPLAY_PROFILE=Object.freeze({
 profileId:TIMELINE_IMAGE_DISPLAY_PROFILE_ID,resizeProfileId:TIMELINE_IMAGE_RESIZE_PROFILE_ID,
 tableSha256:TIMELINE_IMAGE_DISPLAY_TABLE_SHA256,tableEntries:256,tableBytes:14738,
 input:'srgb-output-referred-rgb8-straight-alpha',output:'bt1886-relative-zero-black-gamma2.4',
 primaries:'bt709',whitePoint:'D65',alpha:'separate-premultiplied-resize',
 interpolation:'bilinear-mirrored-edge',compositing:'encoded-rgb8-premultiplied',
});
const invalid=():Error=>Object.assign(new Error('The frozen image render geometry or internal display table is invalid.'),{code:'INVALID_TIMELINE_COLOUR'});

// Fixed RGB8-grid samples of pow(sRGB_EOTF(code/255),1/2.4). This is the
// output-referred, relative zero-black display transform, NOT the Rec.709
// source OETF. Preserve these decimal strings and their canonical byte hash;
// host floating-point formatting must not alter the frozen resource identity.
// The table does not admit fractional/16-bit sources or user-supplied 1D LUTs.
const DISPLAY_VALUES=`0.0 0.034217547394069944 0.04567494597355656 0.05408158363315849
0.060968738222566446 0.06690928350286877 0.0721902532101698 0.07697914104418652
0.0813835016379416 0.08547712828702621 0.08931317823359085 0.09302109469380171
0.09673822135489267 0.10045534801598366 0.10417247467707462 0.10788960133816561
0.11160672799925657 0.11532385466034756 0.11904098132143853 0.12275810798252952
0.12647523464362048 0.13019236130471148 0.13390948796580243 0.13762661462689343
0.14134374128798438 0.14506086794907538 0.14877799461016633 0.15249512127125733
0.1562122479323483 0.15992937459343928 0.16364650125453026 0.16736362791562123
0.1710807545767122 0.17479788123780318 0.17851500789889416 0.18223213455998516
0.1859492612210761 0.1896663878821671 0.19338351454325806 0.19710064120434906
0.20081776786544 0.204534894526531 0.20825202118762198 0.21196914784871296
0.21568627450980393 0.2194034011708949 0.22312052783198588 0.22683765449307686
0.23055478115416783 0.23427190781525883 0.2379890344763498 0.24170616113744078
0.24542328779853173 0.24914041445962276 0.25285754112071374 0.2565746677818047
0.26029179444289563 0.26400892110398666 0.26772604776507763 0.2714431744261686
0.27516030108725953 0.27887742774835056 0.28259455440944153 0.2863116810705325
0.2900288077316235 0.2937459343927144 0.29746306105380543 0.3011801877148964
0.3048973143759874 0.30861444103707836 0.31233156769816933 0.3160486943592603
0.3197658210203513 0.32348294768144226 0.32720007434253323 0.3309172010036242
0.3346343276647152 0.33835145432580616 0.3420685809868972 0.3457857076479881
0.3495028343090791 0.35321996097017005 0.3569370876312611 0.36065421429235206
0.364371340953443 0.36808846761453395 0.371805594275625 0.37552272093671596
0.37923984759780693 0.38295697425889785 0.3866741009199889 0.39039122758107986
0.39410835424217083 0.39782548090326175 0.4015426075643528 0.40525973422544376
0.40897686088653473 0.4126939875476257 0.4164111142087167 0.42012824086980766
0.42384536753089863 0.4275624941919896 0.43127962085308064 0.43499674751417156
0.43871387417526253 0.4424310008363535 0.44614812749744454 0.44986525415853545
0.45358238081962643 0.4572995074807174 0.46101663414180843 0.4647337608028994
0.46845088746399033 0.4721680141250813 0.47588514078617233 0.4796022674472633
0.4833193941083543 0.4870365207694452 0.4907536474305363 0.49447077409162726
0.49818790075271824 0.5019050274138092 0.5056221540749002 0.5093392807359911
0.513056407397082 0.5167735340581731 0.5204906607192641 0.5242077873803551
0.527924914041446 0.531642040702537 0.535359167363628 0.5390762940247189
0.54279342068581 0.546510547346901 0.5502276740079919 0.5539448006690829
0.5576619273301738 0.5613790539912649 0.5650961806523558 0.5688133073134467
0.5725304339745378 0.5762475606356288 0.5799646872967197 0.5836818139578107
0.5873989406189016 0.5911160672799927 0.5948331939410836 0.5985503206021745
0.6022674472632656 0.6059845739243566 0.6097017005854476 0.6134188272465385
0.6171359539076294 0.6208530805687205 0.6245702072298114 0.6282873338909024
0.6320044605519934 0.6357215872130844 0.6394387138741754 0.6431558405352663
0.6468729671963573 0.6505900938574483 0.6543072205185392 0.6580243471796302
0.6617414738407212 0.6654586005018123 0.6691757271629032 0.6728928538239941
0.6766099804850851 0.6803271071461761 0.6840442338072671 0.687761360468358
0.691478487129449 0.6951956137905401 0.698912740451631 0.7026298671127219
0.7063469937738129 0.7100641204349039 0.7137812470959949 0.7174983737570858
0.7212155004181768 0.7249326270792679 0.7286497537403588 0.7323668804014498
0.7360840070625407 0.7398011337236317 0.7435182603847227 0.7472353870458136
0.7509525137069047 0.7546696403679957 0.7583867670290866 0.7621038936901776
0.7658210203512685 0.7695381470123596 0.7732552736734505 0.7769724003345414
0.7806895269956325 0.7844066536567235 0.7881237803178145 0.7918409069789054
0.7955580336399963 0.7992751603010874 0.8029922869621783 0.8067094136232693
0.8104265402843603 0.8141436669454513 0.8178607936065423 0.8215779202676332
0.8252950469287241 0.8290121735898152 0.8327293002509061 0.8364464269119971
0.8401635535730881 0.8438806802341791 0.8475978068952701 0.851314933556361
0.855032060217452 0.858749186878543 0.8624663135396339 0.8661834402007249
0.8699005668618159 0.873617693522907 0.8773348201839979 0.8810519468450888
0.8847690735061798 0.8884862001672708 0.8922033268283618 0.8959204534894527
0.8996375801505437 0.9033547068116348 0.9070718334727257 0.9107889601338167
0.9145060867949076 0.9182232134559986 0.9219403401170896 0.9256574667781805
0.9293745934392715 0.9330917201003626 0.9368088467614535 0.9405259734225445
0.9442431000836354 0.9479602267447264 0.9516773534058173 0.9553944800669082
0.9591116067279994 0.9628287333890904 0.9665458600501813 0.9702629867112723
0.9739801133723632 0.9776972400334543 0.9814143666945452 0.9851314933556361
0.9888486200167271 0.992565746677818 0.9962828733389091 1.0`.split(/\s+/u);
export function timelineImageDisplayTable():{readonly text:string;readonly bytes:number;readonly sha256:string} {
 const text='LUT_1D_SIZE 256\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n'+DISPLAY_VALUES.map(value=>`${value} ${value} ${value}\n`).join('');
 if(DISPLAY_VALUES.length!==256||Buffer.byteLength(text)!==TIMELINE_IMAGE_DISPLAY_PROFILE.tableBytes||createHash('sha256').update(text).digest('hex')!==TIMELINE_IMAGE_DISPLAY_TABLE_SHA256)throw invalid();
 return Object.freeze({text,bytes:TIMELINE_IMAGE_DISPLAY_PROFILE.tableBytes,sha256:TIMELINE_IMAGE_DISPLAY_TABLE_SHA256});
}

export interface TimelineImageFilterOptions {
 readonly input:string;readonly label:string;
 readonly sourceWidth:number;readonly sourceHeight:number;readonly width:number;readonly height:number;
 /** Paths are supplied only by the renderer's owned, verified staging set. */
 readonly displayTablePath:string;readonly creativeLutPath?:string;
}
const FLOAT='format=gbrp,zscale=matrixin=gbr:matrix=gbr:rangein=full:range=full:dither=none,format=gbrpf32le';
const MERGE='mergeplanes=format=gbrapf32le:map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=0';
const dimension=(value:number):boolean=>Number.isSafeInteger(value)&&value>=1&&value<=16384;

/** Pure bounded graph builder for an already admitted static RGB/RGBA8 PNG.
 * Never probes, stages files, parses user filter grammar or infers colour. The
 * caller verifies source admission and the owned LUT bytes before each child.
 * Label is an internal per-input namespace. Output is premultiplied RGBA8;
 * the caller MUST overlay with format=rgb:alpha=premultiplied. Temporal trim,
 * FPS and tpad remain the timeline renderer's responsibility.
 *
 * Preserve the explicit copy boundaries before BOTH LUT filters: supported
 * FFmpeg builds otherwise exhibit a narrow/odd planar allocation defect.
 * Alpha is split before either LUT, premultiplied only after the creative look,
 * resized with RGB, and quantized outside RGB range/depth conversion. zscale's
 * bilinear scaler uses mirrored-edge extension, including the downscale kernel.
 */
export function timelineImageFilterGraph(options:TimelineImageFilterOptions):string[] {
 const {input,label,sourceWidth,sourceHeight,width,height,displayTablePath,creativeLutPath}=options;
 if(typeof input!=='string'||!(/^(?:[0-9]{1,3}:(?:v:)?[0-9]{1,3}|[a-zA-Z][a-zA-Z0-9_]{0,63})$/u).test(input)||
  typeof label!=='string'||!(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u).test(label)||
  ![sourceWidth,sourceHeight,width,height].every(dimension)||sourceWidth>4096||sourceHeight>4096||sourceWidth*sourceHeight>2073600)throw invalid();
 // Integer products choose the constrained edge exactly, avoiding a one-pixel
 // floating-point loss when a nominal scale factor rounds just below an integer.
 const fitWidth=width*sourceHeight<=height*sourceWidth;
 const fittedWidth=fitWidth?width:Math.max(1,Math.floor(sourceWidth*height/sourceHeight));
 const fittedHeight=fitWidth?Math.max(1,Math.floor(sourceHeight*width/sourceWidth)):height;
 const table=timelineColourFilterPath(displayTablePath),look=creativeLutPath===undefined?'':`,copy,lut3d=file=${timelineColourFilterPath(creativeLutPath)}:interp=tetrahedral`;
 const n=(suffix:string):string=>`${label}_${suffix}`;
 const resize=fittedWidth===sourceWidth&&fittedHeight===sourceHeight?'':`,zscale=w=${fittedWidth}:h=${fittedHeight}:filter=bilinear:matrixin=gbr:matrix=gbr:rangein=full:range=full:dither=none`;
 return [
  `[${input}]format=rgba,split[${n('colour')}][${n('alpha')}]`,
  `[${n('colour')}]${FLOAT},copy,lut1d=file=${table}:interp=linear${look},setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=gbr[${n('rgb')}]`,
  `[${n('alpha')}]alphaextract,${FLOAT}[${n('aa')}]`,
  `[${n('rgb')}][${n('aa')}]${MERGE}[${n('straight')}]`,
  `[${n('straight')}]premultiply=inplace=1${resize}[${n('scaled')}]`,
  `[${n('scaled')}]format=gbrapf32le,split[${n('qc')}][${n('qa')}]`,
  `[${n('qc')}]format=gbrpf32le,zscale=matrixin=gbr:matrix=gbr:rangein=full:range=full:dither=none,format=gbrp[${n('qrgb')}]`,
  `[${n('qa')}]alphaextract,format=gray[${n('qalpha')}]`,
  `[${n('qrgb')}][${n('qalpha')}]alphamerge,format=rgba,setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[${label}]`,
 ];
}
