import React, { useState } from 'react';
import { HelpCircle, CheckCircle2, Sparkles, Send, X } from 'lucide-react';

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  is_recommended?: boolean;
  preview_snippet?: string;
}

export interface AskUserQuestionPayload {
  question_id: string;
  title: string;
  description?: string;
  options: QuestionOption[];
  allow_multiple?: boolean;
  allow_custom_input?: boolean;
}

interface AskUserQuestionModalProps {
  question: AskUserQuestionPayload | null;
  isOpen: boolean;
  onSubmit: (questionId: string, selectedOptions: string[], customInput: string) => void;
  onClose: () => void;
}

export const AskUserQuestionModal: React.FC<AskUserQuestionModalProps> = ({
  question,
  isOpen,
  onSubmit,
  onClose,
}) => {
  if (!isOpen || !question) return null;

  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const rec = question.options.find((o) => o.is_recommended);
    return rec ? [rec.id] : question.options.length > 0 ? [question.options[0].id] : [];
  });
  const [customInput, setCustomInput] = useState('');

  const toggleOption = (id: string) => {
    if (question.allow_multiple) {
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      );
    } else {
      setSelectedIds([id]);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedIds.length === 0 && !customInput.trim()) return;
    onSubmit(question.question_id, selectedIds, customInput.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-neutral-900 border border-neutral-700/80 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-900/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <HelpCircle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-neutral-100">
                {question.title || '决策确认'}
              </h3>
              <p className="text-xs text-neutral-400">
                {question.allow_multiple ? '多选决策卡片' : '单选决策卡片'} · 请选择一个方案继续
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-200 p-1.5 rounded-lg hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 flex-1">
          {question.description && (
            <p className="text-sm text-neutral-300 leading-relaxed bg-neutral-800/40 p-3.5 rounded-xl border border-neutral-800">
              {question.description}
            </p>
          )}

          {/* Options List */}
          <div className="space-y-2.5">
            {question.options.map((opt) => {
              const isSelected = selectedIds.includes(opt.id);
              return (
                <div
                  key={opt.id}
                  onClick={() => toggleOption(opt.id)}
                  className={`relative p-3.5 rounded-xl border cursor-pointer transition-all duration-150 ${
                    isSelected
                      ? 'bg-indigo-500/10 border-indigo-500/50 shadow-sm shadow-indigo-500/10'
                      : 'bg-neutral-800/30 border-neutral-800 hover:bg-neutral-800/60 hover:border-neutral-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5">
                        <div
                          className={`w-4 h-4 rounded-${
                            question.allow_multiple ? 'md' : 'full'
                          } border flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-500 text-white'
                              : 'border-neutral-600 bg-neutral-900'
                          }`}
                        >
                          {isSelected && <CheckCircle2 className="w-3.5 h-3.5" />}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-neutral-100">
                            {opt.label}
                          </span>
                          {opt.is_recommended && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-md">
                              <Sparkles className="w-3 h-3" /> 推荐
                            </span>
                          )}
                        </div>
                        {opt.description && (
                          <p className="text-xs text-neutral-400 mt-1 leading-normal">
                            {opt.description}
                          </p>
                        )}
                        {opt.preview_snippet && (
                          <pre className="text-[11px] font-mono bg-black/40 text-neutral-300 p-2 rounded-lg mt-2 overflow-x-auto border border-neutral-800/80">
                            <code>{opt.preview_snippet}</code>
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Custom Input */}
          {question.allow_custom_input !== false && (
            <div className="pt-2">
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                自定义补充意见（可选）
              </label>
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="若有特殊调整，可在此简要补充..."
                className="w-full bg-neutral-800/50 border border-neutral-700/60 rounded-xl px-3.5 py-2 text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-3 border-t border-neutral-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-xl transition-colors"
            >
              稍后决定
            </button>
            <button
              type="submit"
              disabled={selectedIds.length === 0 && !customInput.trim()}
              className="px-5 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl shadow-lg shadow-indigo-600/20 flex items-center gap-1.5 transition-all"
            >
              <Send className="w-3.5 h-3.5" /> 确认并继续
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
