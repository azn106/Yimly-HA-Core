import React, { useState } from "react";
import { usePWAInstall } from "../hooks/usePWAInstall";
import { Download, X } from "lucide-react";

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-2 rounded-2xl bg-indigo-600/95 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-indigo-600 hover:shadow transition cursor-pointer"
      >
        <Download className="w-3.5 h-3.5" />
        Install PWA Application
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-2 rounded-2xl border border-slate-100 px-4 py-2.5 text-xs font-bold text-slate-600 bg-slate-50/50 hover:bg-slate-50 transition cursor-pointer"
        >
          <Download className="w-3.5 h-3.5 text-slate-500" />
          Install iOS Application
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-[0_24px_64px_rgba(148,163,184,0.12)] border border-slate-100/80">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-slate-800">Install on iOS Device</h3>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="text-slate-400 hover:text-slate-600 transition cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
              <p className="text-xs text-slate-400 font-semibold leading-relaxed">
                1. Tap the <strong className="text-indigo-600">Share</strong> icon in the Safari navigation bar at the bottom.<br /><br />
                2. Scroll down the sharing panel and tap <strong>Add to Home Screen</strong>.<br /><br />
                3. Name it and click <strong>Add</strong> at the top-right to launch as a standalone PWA.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-6 w-full rounded-2xl bg-slate-100/80 py-3 text-xs font-bold text-slate-600 hover:bg-slate-200/80 transition"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
