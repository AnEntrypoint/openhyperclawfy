"use client";

import { useRef, useEffect, useState, Suspense, useCallback } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF, Environment, Center, Bounds } from "@react-three/drei";
import * as THREE from "three";

const mouse = { x: 0, y: 0 };

function FPSLimiter({ fps }: { fps: number }) {
  const { invalidate } = useThree();
  useEffect(() => {
    const interval = setInterval(() => invalidate(), 1000 / fps);
    return () => clearInterval(interval);
  }, [fps, invalidate]);
  return null;
}

function MoltyModel({ onLoaded }: { onLoaded: () => void }) {
  const { scene } = useGLTF("/3D/molty.glb");
  const ref = useRef<THREE.Group>(null!);
  const smoothed = useRef({ x: 0, y: 0 });
  const called = useRef(false);

  useFrame((_state, delta) => {
    if (!ref.current) return;

    if (!called.current) {
      called.current = true;
      onLoaded();
    }

    const speed = 3 * delta;
    smoothed.current.x += (mouse.x - smoothed.current.x) * speed;
    smoothed.current.y += (mouse.y - smoothed.current.y) * speed;

    ref.current.position.x = smoothed.current.x * 0.15;
    ref.current.position.y = smoothed.current.y * 0.08;

    ref.current.rotation.y = smoothed.current.x * 0.25;
    ref.current.rotation.x = -smoothed.current.y * 0.2;
    ref.current.rotation.z = -smoothed.current.x * 0.06;
  });

  return (
    <group ref={ref}>
      <Center>
        <primitive object={scene} />
      </Center>
    </group>
  );
}

function Lights() {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} color="#ffffff" />
      <directionalLight position={[-3, 4, -2]} intensity={0.4} color="#a0c4ff" />
      <pointLight position={[0, -2, 4]} intensity={0.3} color="#ff9e9e" />
    </>
  );
}

export default function MoltyScene() {
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const glowRef = useRef<HTMLDivElement>(null);
  const glowSmoothed = useRef({ x: 0, y: 0 });

  const onLoaded = useCallback(() => {
    setTimeout(() => setVisible(true), 100);
  }, []);

  useEffect(() => {
    setReady(true);
    const handleMouseMove = (e: MouseEvent) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("mousemove", handleMouseMove);

    let raf: number;
    const animateGlow = () => {
      raf = requestAnimationFrame(animateGlow);
      if (!glowRef.current) return;
      glowSmoothed.current.x += (mouse.x - glowSmoothed.current.x) * 0.05;
      glowSmoothed.current.y += (mouse.y - glowSmoothed.current.y) * 0.05;
      const tx = glowSmoothed.current.x * 12;
      const ty = -glowSmoothed.current.y * 8;
      glowRef.current.style.transform = `translate(${tx}px, ${ty}px)`;
    };
    animateGlow();

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  if (!ready) return <div style={{ width: 200, height: 200 }} />;

  return (
    <div
      style={{
        width: 200,
        height: 200,
        position: "relative",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.8s ease-in",
      }}
    >
      {/* Pink bloom glow behind the model */}
      <div
        ref={glowRef}
        style={{
          position: "absolute",
          inset: -40,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(220, 80, 120, 0.35) 0%, rgba(180, 60, 100, 0.15) 40%, transparent 70%)",
          filter: "blur(30px)",
          pointerEvents: "none",
          zIndex: 0,
          willChange: "transform",
        }}
      />
      <Canvas
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, 0, 4], fov: 30 }}
        frameloop="demand"
        style={{ background: "transparent", position: "absolute", inset: 0, zIndex: 1 }}
      >
        <FPSLimiter fps={60} />
        <Lights />
        <Suspense fallback={null}>
          <Bounds fit clip margin={1.2} damping={0}>
            <MoltyModel onLoaded={onLoaded} />
          </Bounds>
          <Environment preset="city" environmentIntensity={0.3} />
        </Suspense>
      </Canvas>
    </div>
  );
}
