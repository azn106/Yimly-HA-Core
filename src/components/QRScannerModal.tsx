import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import jsQR from "jsqr";
import { Camera, X, Upload, AlertCircle } from "lucide-react";

interface QRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (code: string) => void;
}

export const QRScannerModal: React.FC<QRScannerModalProps> = ({ isOpen, onClose, onScan }) => {
  const [error, setError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return;
    }

    startCamera();

    return () => {
      stopCamera();
    };
  }, [isOpen]);

  const stopCamera = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  const startCamera = async () => {
    setError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API is not supported on this device/browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true");
        await videoRef.current.play();
        setCameraActive(true);
        scanFrame();
      }
    } catch (err: any) {
      console.warn("Camera access failed or disallowed:", err);
      setError(
        err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
          ? "Camera permission was denied. You can upload an image of the QR code below instead."
          : "Camera unavailable. Please upload a photo of the QR code or enter code manually."
      );
    }
  };

  const scanFrame = () => {
    if (!videoRef.current || !canvasRef.current) return;

    if (videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert"
        });

        if (code && code.data) {
          stopCamera();
          onScan(code.data.trim());
          return;
        }
      }
    }

    animationFrameRef.current = requestAnimationFrame(scanFrame);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          stopCamera();
          onScan(code.data.trim());
        } else {
          setError("Could not find a valid QR code in this image. Please try another image or enter the code manually.");
        }
      }
    };
    img.onerror = () => {
      setError("Failed to load image file.");
    };
    img.src = URL.createObjectURL(file);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto pointer-events-auto">
      <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-100 relative flex flex-col items-center my-auto max-h-[calc(100dvh-2.5rem)] overflow-y-auto">
        <button
          onClick={() => {
            stopCamera();
            onClose();
          }}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3">
          <Camera className="w-6 h-6" />
        </div>

        <h3 className="text-base font-bold text-slate-800 text-center">Scan Circle QR Code</h3>
        <p className="text-xs text-slate-500 text-center mt-1 mb-4">
          Point your camera at a Family Circle invite QR code
        </p>

        {/* Video / Camera Viewport */}
        <div className="relative w-full aspect-square bg-slate-900 rounded-2xl overflow-hidden flex items-center justify-center border border-slate-200 shadow-inner">
          <video
            ref={videoRef}
            className={`w-full h-full object-cover ${cameraActive ? "opacity-100" : "opacity-0"}`}
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Scanner Targeting Reticle */}
          {cameraActive && (
            <div className="absolute inset-8 border-2 border-indigo-500/80 rounded-xl pointer-events-none flex items-center justify-center">
              <div className="w-full h-0.5 bg-indigo-500/90 shadow-[0_0_8px_#6366f1] animate-bounce" />
            </div>
          )}

          {!cameraActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center text-slate-400">
              <Camera className="w-10 h-10 mb-2 opacity-50" />
              <span className="text-xs font-medium">
                {error ? "Camera unavailable" : "Starting camera..."}
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 w-full p-2.5 bg-amber-50 border border-amber-200/70 rounded-xl flex items-start gap-2 text-[11px] text-amber-800">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <span>{error}</span>
          </div>
        )}

        {/* Upload QR Image Fallback */}
        <div className="mt-4 w-full flex flex-col gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept="image/*"
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition flex items-center justify-center gap-2 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>Upload QR code photo</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
