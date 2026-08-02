/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Full git SHA of the commit this bundle was built from. Injected by the
   *  Publish workflow via a Docker build-arg; absent in a local dev build. */
  readonly VITE_BUILD_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
