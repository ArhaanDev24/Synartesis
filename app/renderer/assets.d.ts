/**
 * What Vite does with an imported image.
 *
 * The renderer's tsconfig takes no ambient `types`, on purpose -- pulling in
 * every @types package on the machine is how a window ends up compiling
 * against node's globals it cannot use. This is the one thing it does need.
 */
declare module "*.png" {
  const url: string;
  export default url;
}
