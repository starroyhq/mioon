import React from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  AlertTriangle, BookOpen, Box, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, CircleX, Clock, Columns2, Download, Expand,
  FileOutput, FileText, Film, Folder, GripVertical, Hand, Image, Info, Layers, LayoutGrid, Link2, LocateFixed, Lock, LockOpen,
  Magnet, Minus, Music, Pause, Pencil, Play, Plus, Redo2, RefreshCw, Scissors, Search, Shield, SlidersVertical,
  Sparkles, Square, Terminal, Type, Undo2, Upload, Volume2, WORKBENCH_ICON_STROKE_WIDTH, Wrench, X, Zap,
} from '@mioon/ui/components/workbench-icons';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> { name: string; size?: number }

type LucideLike = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number | string }>;

const lucideIcons: Record<string, LucideLike> = {
  magnet: Magnet,
  music: Music,
  plus: Plus,
  scissors: Scissors,
  arrow: ChevronRight,
  left: ChevronLeft,
  down: ChevronDown,
  upload: Upload,
  download: Download,
  image: Image,
  film: Film,
  text: Type,
  play: Play,
  pause: Pause,
  volume: Volume2,
  warning: AlertTriangle,
  sparkle: Sparkles,
  grid: LayoutGrid,
  board: LayoutGrid,
  folder: Folder,
  check: Check,
  close: X,
  refresh: RefreshCw,
  undo: Undo2,
  redo: Redo2,
  zoom: Expand,
  minus: Minus,
  compare: Columns2,
  clock: Clock,
  link: Link2,
  bolt: Zap,
  layers: Layers,
  settings: SlidersVertical,
  unlock: LockOpen,
  info: Info,
  grip: GripVertical,
  stop: Square,
  lock: Lock,
  search: Search,
  pencil: Pencil,
  question: CircleHelp,
  shield: Shield,
  hand: Hand,
  locate: LocateFixed,
  book: BookOpen,
  note: FileText,
  box: Box,
  fcpExport: FileOutput,
  circleX: CircleX,
  terminal: Terminal,
  wrench: Wrench,
};

// Domain-specific glyphs without a direct Lucide equivalent keep the unified
// 1.5px workbench stroke width.
const customPaths: Record<string, ReactNode> = {
  transition: <path d="M4 5v14l8-7Zm16 0v14l-8-7Z" />,
};

export default function Icon({ name, size = 18, strokeWidth = WORKBENCH_ICON_STROKE_WIDTH, ...props }: IconProps) {
  const custom = customPaths[name];
  if (custom) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{custom}</svg>;
  }
  const Component = lucideIcons[name] ?? Film;
  return <Component size={size} strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
}
