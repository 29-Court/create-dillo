declare module "*.txt" {
  const source: string;
  export default source;
}

declare module "*.module.js" {
  const source: string;
  export default source;
}

declare module "*.bundle.js" {
  const source: string;
  export default source;
}

declare const ARMADILLO_BUILD_VERSION: string;
