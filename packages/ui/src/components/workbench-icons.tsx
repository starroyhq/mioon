import React from 'react';
import { AlertCircleIcon, CheckIcon, EllipsisIcon, Grid2X2Icon, ListIcon, PlusIcon, SettingsIcon, SearchIcon, UploadIcon, XIcon } from 'lucide-react';
import type { LucideProps } from 'lucide-react';
const icons = { warning:AlertCircleIcon, check:CheckIcon, more:EllipsisIcon, grid:Grid2X2Icon, list:ListIcon, plus:PlusIcon, settings:SettingsIcon, search:SearchIcon, upload:UploadIcon, close:XIcon };
export function WorkbenchIcon({ name, size = 16, ...props }: LucideProps & {name:keyof typeof icons}) {
  const Component = icons[name];
  return <Component size={size} aria-hidden="true" {...props} />;
}
// Existing Lucide dependency stays inside the UI package. Application leaves
// share these named exports without depending on a transitive web dependency.
export { Clock, LoaderCircle, Eye, EyeOff, Volume2, VolumeX, MoreHorizontal, Trash2, ArrowLeftToLine, Play, CornerUpLeft, AlertTriangle, AudioLines, Pause, StepBack, StepForward, Maximize, MousePointer2, Magnet, Plus, ChevronDown, LocateFixed, Minus, ChevronUp, Film, Headphones, ChevronRight, SlidersHorizontal, Grid2X2, List, X, Type, Image, Video, Sparkles, Link, Clapperboard, Layers, Check, ArrowUp, ArrowDown, Star, CircleSlash, RotateCcw } from 'lucide-react';
