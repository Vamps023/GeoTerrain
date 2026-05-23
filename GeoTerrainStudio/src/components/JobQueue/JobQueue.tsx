import React, { useEffect, useState, useCallback } from 'react';
import { Play, Square, RotateCcw, Download, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { useTerrainStore } from '../../core/store';
import { Native, onProgressUpdate } from '../../core/ipc';
import type { JobProgress } from '../../types/terrain';

export const JobQueue: React.FC = () => {
  const activeJobId = useTerrainStore((s) => s.activeJobId);
  const jobProgress = useTerrainStore((s) => s.jobProgress);
  const generationPlan = useTerrainStore((s) => s.generationPlan);
  const setActiveJobId = useTerrainStore((s) => s.setActiveJobId);
  const setJobProgress = useTerrainStore((s) => s.setJobProgress);
  const resetGeneration = useTerrainStore((s) => s.resetGeneration);
  const selectedBounds = useTerrainStore((s) => s.selectedBounds);
  const setActiveTab = useTerrainStore((s) => s.setActiveTab);

  const [isGenerating, setIsGenerating] = useState(false);

  // Subscribe to progress updates
  useEffect(() => {
    if (!activeJobId) return;
    const unsubscribe = onProgressUpdate((progress: JobProgress) => {
      setJobProgress(progress);
      if (progress.state === 'complete' || progress.state === 'cancelled' || progress.state === 'error') {
        setIsGenerating(false);
      }
    });
    return unsubscribe;
  }, [activeJobId, setJobProgress]);

  // Poll progress as fallback
  useEffect(() => {
    if (!activeJobId || !isGenerating) return;
    const interval = setInterval(async () => {
      try {
        const progress = await Native.getProgress(activeJobId);
        setJobProgress(progress);
        if (progress.state === 'complete' || progress.state === 'cancelled' || progress.state === 'error') {
          setIsGenerating(false);
        }
      } catch (err) {
        console.error('Progress poll error:', err);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [activeJobId, isGenerating, setJobProgress]);

  const handleStart = useCallback(async () => {
    if (!generationPlan || !selectedBounds) return;
    try {
      setIsGenerating(true);
      const sessionId = `session-${Date.now()}`;
      const jobId = await Native.startGeneration(sessionId, generationPlan);
      setActiveJobId(jobId);
    } catch (err) {
      console.error('Failed to start generation:', err);
      setIsGenerating(false);
    }
  }, [generationPlan, selectedBounds, setActiveJobId]);

  const handleCancel = useCallback(async () => {
    if (!activeJobId) return;
    try {
      await Native.cancelGeneration(activeJobId);
      setIsGenerating(false);
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
  }, [activeJobId]);

  const handleReset = useCallback(() => {
    resetGeneration();
    setIsGenerating(false);
  }, [resetGeneration]);

  const getStateIcon = () => {
    if (!jobProgress) return <Clock className="w-5 h-5 text-gray-500" />;
    switch (jobProgress.state) {
      case 'complete':
        return <CheckCircle className="w-5 h-5 text-green-400" />;
      case 'error':
        return <AlertCircle className="w-5 h-5 text-red-400" />;
      case 'downloading':
        return <Download className="w-5 h-5 text-blue-400 animate-bounce" />;
      default:
        return <Clock className="w-5 h-5 text-cyan-400" />;
    }
  };

  const progressPercent = Math.round((jobProgress?.overallProgress ?? 0) * 100);

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-400" />
          Job Queue
        </h2>
      </div>

      {/* Job Card */}
      <div className="p-4 space-y-4">
        {!generationPlan ? (
          <div className="text-center py-8 text-gray-500">
            <p className="text-sm">No jobs queued.</p>
            <p className="text-xs mt-1">Plan a generation from the map first.</p>
          </div>
        ) : (
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {getStateIcon()}
                <span className="text-sm font-medium">
                  {jobProgress?.state === 'complete'
                    ? 'Complete'
                    : jobProgress?.state === 'error'
                    ? 'Error'
                    : isGenerating
                    ? 'Generating...'
                    : 'Ready'}
                </span>
              </div>
              <span className="text-xs text-gray-500">
                {generationPlan.tiles.length} tiles
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  jobProgress?.state === 'error'
                    ? 'bg-red-500'
                    : jobProgress?.state === 'complete'
                    ? 'bg-green-500'
                    : 'bg-cyan-500'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mb-3">
              <span>{progressPercent}%</span>
              <span>{jobProgress?.currentTile ?? 'Waiting...'}</span>
            </div>

            {/* Message */}
            {jobProgress?.message && (
              <p className="text-xs text-gray-400 mb-3">{jobProgress.message}</p>
            )}
            {jobProgress?.error && (
              <p className="text-xs text-red-400 mb-3">{jobProgress.error}</p>
            )}

            {/* Controls */}
            <div className="flex gap-2">
              {!isGenerating && jobProgress?.state !== 'complete' && (
                <button
                  onClick={handleStart}
                  className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs py-1.5 px-3 rounded transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  Start
                </button>
              )}
              {isGenerating && (
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white text-xs py-1.5 px-3 rounded transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  Cancel
                </button>
              )}
              {(jobProgress?.state === 'complete' || jobProgress?.state === 'error' || jobProgress?.state === 'cancelled') && (
                <>
                  <button
                    onClick={handleReset}
                    className="flex items-center gap-1.5 bg-gray-600 hover:bg-gray-500 text-white text-xs py-1.5 px-3 rounded transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset
                  </button>
                  {jobProgress?.state === 'complete' && (
                    <button
                      onClick={() => setActiveTab('export')}
                      className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 text-white text-xs py-1.5 px-3 rounded transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
