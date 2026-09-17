declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "*.ttf" {
  const content: Uint8Array;
  export default content;
}
