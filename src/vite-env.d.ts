/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CULL_DEVHUD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
