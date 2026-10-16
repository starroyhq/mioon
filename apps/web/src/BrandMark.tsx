import React from 'react';

const brandMarkUrl = new URL('./assets/mioon-mark.png', import.meta.url).href;

export default function BrandMark() {
  // The shared source keeps its square canvas; .brand-mark crops the outer padding.
  return <img src={brandMarkUrl} alt="" width={1254} height={1254} draggable={false} />;
}
