import type { CSSProperties } from "react";
import googleIcon from "@lobehub/icons-static-svg/icons/google.svg";

type BundledIcon = string | { src: string };

export function GoogleIcon({ className = "" }: { className?: string }) {
  const bundled = googleIcon as BundledIcon;
  const source = typeof bundled === "string" ? bundled : bundled.src;
  const style = { "--google-icon": `url("${source}")` } as CSSProperties;
  return <span className={`google-outline-icon ${className}`.trim()} style={style} aria-hidden="true" />;
}
