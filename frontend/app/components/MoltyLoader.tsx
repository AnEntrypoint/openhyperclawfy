"use client";

import dynamic from "next/dynamic";

const MoltyScene = dynamic(() => import("./MoltyScene"), {
  ssr: false,
  loading: () => <div className="h-48 w-48 sm:h-56 sm:w-56" />,
});

export default function MoltyLoader() {
  return <MoltyScene />;
}
