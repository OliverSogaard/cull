/**
 * Type barrel — re-exports every shared type so consumers can import from one
 * place (`import type { Rating, Img } from "@/types"`). Source files are split
 * by domain (rating / image / ipc / nav / ui).
 */
export type { Rating, Filter, Change, UndoAction } from "./rating";
export type { Img, PreviewEntry, ImageMetadata } from "./image";
export type { FileOpResult, AnalyzeProgress, AnalyzeResult } from "./ipc";
export type { NavSite, NavEntry, HelpMode, HelpGroup } from "./nav";
export type { Phase, Feedback, SessionSummary } from "./ui";
export type { ExportFolderMode, Settings, StorageMode, ThumbsPosition } from "./settings";
