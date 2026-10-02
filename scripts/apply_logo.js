const fs = require('fs');
const path = require('path');

const sourceImgPath = path.join('src', 'assets', 'images', 'icon_512_1789955294717.jpg');
if (!fs.existsSync(sourceImgPath)) {
  console.error("Source image not found:", sourceImgPath);
  process.exit(1);
}

const imgBuffer = fs.readFileSync(sourceImgPath);
const base64Data = imgBuffer.toString('base64');
const dataUri = `data:image/jpeg;base64,${base64Data}`;

// 1. Update YimlyBrandIcon.tsx
const brandIconCode = `import React from "react";

interface YimlyBrandIconProps {
  className?: string;
  size?: number;
}

export const YimlyBrandIcon: React.FC<YimlyBrandIconProps> = ({
  className = "w-12 h-12",
  size
}) => {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <image
        href="${dataUri}"
        width="1024"
        height="1024"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  );
};
`;

fs.writeFileSync(path.join('src', 'components', 'YimlyBrandIcon.tsx'), brandIconCode);
console.log("Updated src/components/YimlyBrandIcon.tsx");

// 2. Update public SVG icons (icon.svg, favicon.svg)
const svgMaster = `<svg viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <image href="${dataUri}" width="1024" height="1024" preserveAspectRatio="xMidYMid meet" />
</svg>`;

fs.writeFileSync(path.join('public', 'icon.svg'), svgMaster);
fs.writeFileSync(path.join('public', 'favicon.svg'), svgMaster);
console.log("Updated public/icon.svg and public/favicon.svg");

// 3. Copy reference image to all public raster icon targets
const targets = [
  'icon-512.png',
  'icon-192.png',
  'apple-touch-icon.png',
  'favicon.png',
  'icon-maskable-512.png'
];

for (const target of targets) {
  const targetPath = path.join('public', target);
  fs.copyFileSync(sourceImgPath, targetPath);
  console.log(`Copied reference image to public/${target}`);
}

console.log("Brand asset replacement complete successfully!");
