import React, { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>;
type PdfDocumentProxy = Awaited<PdfLoadingTask["promise"]>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;

type PdfPreviewProps = {
  sourceUrl: string;
  initialPage?: number;
  onUnavailable?: () => void;
};

export default function PdfPreview({
  sourceUrl,
  initialPage = 1,
  onUnavailable,
}: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage));
  const [containerWidth, setContainerWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRendering, setIsRendering] = useState(false);

  useEffect(() => {
    setPageNumber(Math.max(1, initialPage));
  }, [initialPage, sourceUrl]);

  useEffect(() => {
    return () => {
      if (pdfDocument) {
        void pdfDocument.destroy();
      }
    };
  }, [pdfDocument]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      setContainerWidth(960);
      return;
    }

    const updateSize = () => {
      setContainerWidth(Math.max(320, Math.floor(element.clientWidth)));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const normalizedUrl = stripHash(sourceUrl);
    const loadingTask = pdfjs.getDocument(normalizedUrl);

    setIsLoading(true);
    setError(null);
    setPdfDocument(null);
    setPageCount(0);

    loadingTask.promise
      .then((document: PdfDocumentProxy) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        setPdfDocument(document);
        setPageCount(document.numPages);
        setPageNumber((current) => clampPage(current || initialPage, document.numPages));
      })
      .catch(() => {
        if (!cancelled) {
          onUnavailable?.();
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [initialPage, onUnavailable, sourceUrl]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current || containerWidth <= 0) {
      return;
    }

    let cancelled = false;
    let activeRenderTask: ReturnType<PdfPageProxy["render"]> | null = null;

    setIsRendering(true);
    setError(null);

    void pdfDocument.getPage(clampPage(pageNumber, pdfDocument.numPages))
      .then((page: PdfPageProxy) => {
        if (cancelled || !canvasRef.current) {
          return;
        }

        const displayWidth = Math.max(320, containerWidth - 32);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.6, Math.min(2.5, displayWidth / baseViewport.width));
        const outputScale = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * outputScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Could not create canvas context.");
        }

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${Math.floor(viewport.width / outputScale)}px`;
        canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`;

        activeRenderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        return activeRenderTask.promise;
      })
      .catch((caughtError: unknown) => {
        if (!cancelled && !isCancelledRenderError(caughtError)) {
          setError(caughtError instanceof Error ? caughtError.message : "Failed to render PDF preview.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsRendering(false);
        }
      });

    return () => {
      cancelled = true;
      activeRenderTask?.cancel();
    };
  }, [containerWidth, pageNumber, pdfDocument]);

  const canStepBackward = pageNumber > 1;
  const canStepForward = pdfDocument ? pageNumber < pdfDocument.numPages : false;

  return (
    <div className="pdf-preview-shell">
      <div className="pdf-preview-toolbar">
        <div className="pdf-preview-status">
          {isLoading ? "Loading PDF…" : pageCount > 0 ? `Page ${pageNumber} of ${pageCount}` : "Preparing preview…"}
        </div>
        <div className="pdf-preview-controls">
          <button
            className="ghost-button compact"
            type="button"
            disabled={!canStepBackward || isLoading}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <button
            className="ghost-button compact"
            type="button"
            disabled={!canStepForward || isLoading}
            onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          >
            Next
          </button>
        </div>
      </div>
      <div className="pdf-preview-stage" ref={containerRef}>
        {error ? <div className="pdf-preview-error">{error}</div> : null}
        <canvas
          className={`pdf-preview-canvas${isRendering ? " rendering" : ""}`}
          ref={canvasRef}
        />
      </div>
    </div>
  );
}

function clampPage(pageNumber: number, pageCount: number): number {
  return Math.max(1, Math.min(Math.max(1, pageCount), Math.max(1, pageNumber)));
}

function stripHash(value: string): string {
  const hashIndex = value.indexOf("#");
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

function isCancelledRenderError(error: unknown): boolean {
  return error instanceof Error && /rendering cancelled/i.test(error.message);
}
