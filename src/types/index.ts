/**
 * Type barrel — re-exports every shared type so consumers can import from one
 * place (`import type { Rating, Img } from "@/types"`). Source files are split
 * by domain (rating / image / ipc / nav / ui).
 */
export type { Rating, Filter, UndoAction } from "./rating";
export type { Img, ImageMetadata } from "./image";
export type { FileOpResult, AnalyzeProgress, AnalyzeResult, ScanResult } from "./ipc";
export type { NavSite, NavEntry, HelpMode, HelpGroup } from "./nav";
export type { Phase, Feedback } from "./ui";
export type { Settings, SmartLevel, StorageMode, ThumbsPosition } from "./settings";
