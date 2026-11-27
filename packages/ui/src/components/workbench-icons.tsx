import React from 'react';
import {
  AlertCircleIcon, CheckIcon, EllipsisIcon, Grid2X2Icon, ListIcon, PlusIcon, SettingsIcon, SearchIcon, UploadIcon, XIcon,
  Clock as ClockBase, LoaderCircle as LoaderCircleBase, Eye as EyeBase, EyeOff as EyeOffBase, Volume2 as Volume2Base,
  VolumeX as VolumeXBase, MoreHorizontal as MoreHorizontalBase, Trash2 as Trash2Base, ArrowLeftToLine as ArrowLeftToLineBase,
  Play as PlayBase, CornerUpLeft as CornerUpLeftBase, AlertTriangle as AlertTriangleBase, AudioLines as AudioLinesBase,
  Pause as PauseBase, StepBack as StepBackBase, StepForward as StepForwardBase, Maximize as MaximizeBase,
  MousePointer2 as MousePointer2Base, Magnet as MagnetBase, Plus as PlusBase, ChevronDown as ChevronDownBase,
  LocateFixed as LocateFixedBase, Minus as MinusBase, ChevronUp as ChevronUpBase, Film as FilmBase,
  Headphones as HeadphonesBase, ChevronRight as ChevronRightBase, ChevronLeft as ChevronLeftBase,
  SlidersHorizontal as SlidersHorizontalBase, SlidersVertical as SlidersVerticalBase, Grid2X2 as Grid2X2Base,
  LayoutGrid as LayoutGridBase, List as ListBase, X as XBase, Type as TypeBase, Image as ImageBase, Images as ImagesBase,
  Video as VideoBase, Sparkles as SparklesBase, Link as LinkBase, Link2 as Link2Base, Clapperboard as ClapperboardBase,
  Layers as LayersBase, Check as CheckBase, ArrowUp as ArrowUpBase, ArrowDown as ArrowDownBase, Star as StarBase,
  CircleSlash as CircleSlashBase, RotateCcw as RotateCcwBase, Scissors as ScissorsBase, FolderOpen as FolderOpenBase,
  Folder as FolderBase, FolderSearch as FolderSearchBase, Replace as ReplaceBase, RefreshCw as RefreshCwBase,
  ListPlus as ListPlusBase, ArrowUpRight as ArrowUpRightBase, Search as SearchBase, Camera as CameraBase, Sun as SunBase,
  Lock as LockBase, LockOpen as LockOpenBase, Upload as UploadBase, CircleCheck as CircleCheckBase,
  CircleAlert as CircleAlertBase, CircleX as CircleXBase, CircleHelp as CircleHelpBase, CircleDot as CircleDotBase,
  User as UserBase, Users as UsersBase, Info as InfoBase, Box as BoxBase, Undo2 as Undo2Base, Redo2 as Redo2Base,
  ArrowLeft as ArrowLeftBase, Orbit as OrbitBase, Move as MoveBase, Umbrella as UmbrellaBase, Smartphone as SmartphoneBase,
  ShoppingBag as ShoppingBagBase, Coffee as CoffeeBase, Cylinder as CylinderBase, Circle as CircleBase, Square as SquareBase,
  PersonStanding as PersonStandingBase, RectangleVertical as RectangleVerticalBase, Diamond as DiamondBase,
  Monitor as MonitorBase, PencilLine as PencilLineBase, Pencil as PencilBase, Focus as FocusBase, ImageDown as ImageDownBase,
  Ratio as RatioBase, Copy as CopyBase, ClipboardPaste as ClipboardPasteBase, CopyPlus as CopyPlusBase,
  Download as DownloadBase, Music as MusicBase, Expand as ExpandBase, Columns2 as Columns2Base, Zap as ZapBase,
  GripVertical as GripVerticalBase, Shield as ShieldBase, Hand as HandBase, BookOpen as BookOpenBase,
  FileText as FileTextBase, Terminal as TerminalBase, Wrench as WrenchBase, Cpu as CpuBase, Keyboard as KeyboardBase,
  PanelLeftClose as PanelLeftCloseBase, PanelRightClose as PanelRightCloseBase,
  PanelLeftOpen as PanelLeftOpenBase, PanelRightOpen as PanelRightOpenBase,
  Inbox as InboxBase, FileX as FileXBase, File as FileBase, FileDown as FileDownBase,
  Bookmark as BookmarkBase, BookmarkPlus as BookmarkPlusBase, History as HistoryBase,
  Calendar as CalendarBase, Captions as CaptionsBase,
} from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

export const WORKBENCH_ICON_STROKE_WIDTH = 1.5;

function withDefaultStroke(IconComponent: LucideIcon): LucideIcon {
  const Wrapped = React.forwardRef<SVGSVGElement, LucideProps>(
    ({ strokeWidth = WORKBENCH_ICON_STROKE_WIDTH, ...props }, ref) => (
      <IconComponent ref={ref} strokeWidth={strokeWidth} {...props} />
    ),
  );
  Wrapped.displayName = IconComponent.displayName ?? IconComponent.name;
  return Wrapped as LucideIcon;
}

const icons = {
  warning: AlertCircleIcon,
  check: CheckIcon,
  more: EllipsisIcon,
  grid: Grid2X2Icon,
  list: ListIcon,
  plus: PlusIcon,
  settings: SettingsIcon,
  search: SearchIcon,
  upload: UploadIcon,
  close: XIcon,
};

export function WorkbenchIcon({
  name,
  size = 16,
  strokeWidth = WORKBENCH_ICON_STROKE_WIDTH,
  ...props
}: LucideProps & { name: keyof typeof icons }) {
  const Component = icons[name];
  return <Component size={size} strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
}

// Existing Lucide dependency stays inside the UI package. Application leaves
// share these named exports (unified at 1.5px stroke width) without depending
// on a transitive web dependency.
export const Clock = withDefaultStroke(ClockBase);
export const LoaderCircle = withDefaultStroke(LoaderCircleBase);
export const Eye = withDefaultStroke(EyeBase);
export const EyeOff = withDefaultStroke(EyeOffBase);
export const Volume2 = withDefaultStroke(Volume2Base);
export const VolumeX = withDefaultStroke(VolumeXBase);
export const MoreHorizontal = withDefaultStroke(MoreHorizontalBase);
export const Trash2 = withDefaultStroke(Trash2Base);
export const ArrowLeftToLine = withDefaultStroke(ArrowLeftToLineBase);
export const Play = withDefaultStroke(PlayBase);
export const CornerUpLeft = withDefaultStroke(CornerUpLeftBase);
export const AlertTriangle = withDefaultStroke(AlertTriangleBase);
export const AudioLines = withDefaultStroke(AudioLinesBase);
export const Pause = withDefaultStroke(PauseBase);
export const StepBack = withDefaultStroke(StepBackBase);
export const StepForward = withDefaultStroke(StepForwardBase);
export const Maximize = withDefaultStroke(MaximizeBase);
export const MousePointer2 = withDefaultStroke(MousePointer2Base);
export const Magnet = withDefaultStroke(MagnetBase);
export const Plus = withDefaultStroke(PlusBase);
export const ChevronDown = withDefaultStroke(ChevronDownBase);
export const LocateFixed = withDefaultStroke(LocateFixedBase);
export const Minus = withDefaultStroke(MinusBase);
export const ChevronUp = withDefaultStroke(ChevronUpBase);
export const Film = withDefaultStroke(FilmBase);
export const Headphones = withDefaultStroke(HeadphonesBase);
export const ChevronRight = withDefaultStroke(ChevronRightBase);
export const ChevronLeft = withDefaultStroke(ChevronLeftBase);
export const SlidersHorizontal = withDefaultStroke(SlidersHorizontalBase);
export const SlidersVertical = withDefaultStroke(SlidersVerticalBase);
export const Grid2X2 = withDefaultStroke(Grid2X2Base);
export const LayoutGrid = withDefaultStroke(LayoutGridBase);
export const List = withDefaultStroke(ListBase);
export const X = withDefaultStroke(XBase);
export const Type = withDefaultStroke(TypeBase);
export const Image = withDefaultStroke(ImageBase);
export const Images = withDefaultStroke(ImagesBase);
export const Video = withDefaultStroke(VideoBase);
export const Sparkles = withDefaultStroke(SparklesBase);
export const Link = withDefaultStroke(LinkBase);
export const Link2 = withDefaultStroke(Link2Base);
export const Clapperboard = withDefaultStroke(ClapperboardBase);
export const Layers = withDefaultStroke(LayersBase);
export const Check = withDefaultStroke(CheckBase);
export const ArrowUp = withDefaultStroke(ArrowUpBase);
export const ArrowDown = withDefaultStroke(ArrowDownBase);
export const Star = withDefaultStroke(StarBase);
export const CircleSlash = withDefaultStroke(CircleSlashBase);
export const RotateCcw = withDefaultStroke(RotateCcwBase);
export const Scissors = withDefaultStroke(ScissorsBase);
export const FolderOpen = withDefaultStroke(FolderOpenBase);
export const Folder = withDefaultStroke(FolderBase);
export const FolderSearch = withDefaultStroke(FolderSearchBase);
export const Replace = withDefaultStroke(ReplaceBase);
export const RefreshCw = withDefaultStroke(RefreshCwBase);
export const ListPlus = withDefaultStroke(ListPlusBase);
export const ArrowUpRight = withDefaultStroke(ArrowUpRightBase);
export const Search = withDefaultStroke(SearchBase);
export const Camera = withDefaultStroke(CameraBase);
export const Sun = withDefaultStroke(SunBase);
export const Lock = withDefaultStroke(LockBase);
export const LockOpen = withDefaultStroke(LockOpenBase);
export const Upload = withDefaultStroke(UploadBase);
export const CircleCheck = withDefaultStroke(CircleCheckBase);
export const CircleAlert = withDefaultStroke(CircleAlertBase);
export const CircleX = withDefaultStroke(CircleXBase);
export const CircleHelp = withDefaultStroke(CircleHelpBase);
export const CircleDot = withDefaultStroke(CircleDotBase);
export const User = withDefaultStroke(UserBase);
export const Users = withDefaultStroke(UsersBase);
export const Info = withDefaultStroke(InfoBase);
export const Box = withDefaultStroke(BoxBase);
export const Undo2 = withDefaultStroke(Undo2Base);
export const Redo2 = withDefaultStroke(Redo2Base);
export const ArrowLeft = withDefaultStroke(ArrowLeftBase);
export const Orbit = withDefaultStroke(OrbitBase);
export const Move = withDefaultStroke(MoveBase);
export const Umbrella = withDefaultStroke(UmbrellaBase);
export const Smartphone = withDefaultStroke(SmartphoneBase);
export const ShoppingBag = withDefaultStroke(ShoppingBagBase);
export const Coffee = withDefaultStroke(CoffeeBase);
export const Cylinder = withDefaultStroke(CylinderBase);
export const Circle = withDefaultStroke(CircleBase);
export const Square = withDefaultStroke(SquareBase);
export const PersonStanding = withDefaultStroke(PersonStandingBase);
export const RectangleVertical = withDefaultStroke(RectangleVerticalBase);
export const Diamond = withDefaultStroke(DiamondBase);
export const Monitor = withDefaultStroke(MonitorBase);
export const PencilLine = withDefaultStroke(PencilLineBase);
export const Pencil = withDefaultStroke(PencilBase);
export const Focus = withDefaultStroke(FocusBase);
export const ImageDown = withDefaultStroke(ImageDownBase);
export const Ratio = withDefaultStroke(RatioBase);
export const Copy = withDefaultStroke(CopyBase);
export const ClipboardPaste = withDefaultStroke(ClipboardPasteBase);
export const CopyPlus = withDefaultStroke(CopyPlusBase);
export const Download = withDefaultStroke(DownloadBase);
export const Music = withDefaultStroke(MusicBase);
export const Expand = withDefaultStroke(ExpandBase);
export const Columns2 = withDefaultStroke(Columns2Base);
export const Zap = withDefaultStroke(ZapBase);
export const GripVertical = withDefaultStroke(GripVerticalBase);
export const Shield = withDefaultStroke(ShieldBase);
export const Hand = withDefaultStroke(HandBase);
export const BookOpen = withDefaultStroke(BookOpenBase);
export const FileText = withDefaultStroke(FileTextBase);
export const Terminal = withDefaultStroke(TerminalBase);
export const Wrench = withDefaultStroke(WrenchBase);
export const Cpu = withDefaultStroke(CpuBase);
export const Keyboard = withDefaultStroke(KeyboardBase);
export const PanelLeftClose = withDefaultStroke(PanelLeftCloseBase);
export const PanelRightClose = withDefaultStroke(PanelRightCloseBase);
export const PanelLeftOpen = withDefaultStroke(PanelLeftOpenBase);
export const PanelRightOpen = withDefaultStroke(PanelRightOpenBase);
export const Inbox = withDefaultStroke(InboxBase);
export const FileX = withDefaultStroke(FileXBase);
export const File = withDefaultStroke(FileBase);
export const FileDown = withDefaultStroke(FileDownBase);
export const Bookmark = withDefaultStroke(BookmarkBase);
export const BookmarkPlus = withDefaultStroke(BookmarkPlusBase);
export const History = withDefaultStroke(HistoryBase);
export const Calendar = withDefaultStroke(CalendarBase);
export const Captions = withDefaultStroke(CaptionsBase);
