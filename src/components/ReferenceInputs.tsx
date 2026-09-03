import { useEffect, useState } from 'react';
import type { StudioApi } from '../api';
import type { GenerationForm, InputAsset, InputAssetKind } from '../types';

interface ReferenceInputsProps {
  mode: 'keyframes' | 'references';
  form: GenerationForm;
  api: StudioApi;
  disabled?: boolean;
  onChange: (patch: Partial<GenerationForm>) => void;
  onUploadStateChange?: (uploading: boolean) => void;
}

const ACCEPT: Record<InputAssetKind, string> = {
  image: '.png,.jpg,.jpeg,.webp',
  video: '.mp4,.mov,.webm',
  audio: '.mp3,.wav,.m4a,.aac,.flac,.ogg',
};

function assetName(asset: InputAsset) {
  return asset.filename.length > 36 ? `${asset.filename.slice(0, 33)}…` : asset.filename;
}

export function ReferenceInputs({ mode, form, api, disabled = false, onChange, onUploadStateChange }: ReferenceInputsProps) {
  const [uploadCount, setUploadCount] = useState(0);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => onUploadStateChange?.(uploadCount > 0), [onUploadStateChange, uploadCount]);

  const upload = async (file: File, kind: InputAssetKind): Promise<InputAsset | undefined> => {
    if (!api.uploadAsset) {
      setError('当前页面尚未连接到支持参考文件上传的本机服务，请刷新后重试。');
      return undefined;
    }
    setError(undefined);
    setUploadCount((count) => count + 1);
    try {
      return await api.uploadAsset(file, kind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文件上传失败，请重试。');
      return undefined;
    } finally {
      setUploadCount((count) => Math.max(0, count - 1));
    }
  };

  const chooseKeyframe = async (file: File | undefined, field: 'firstFrame' | 'lastFrame') => {
    if (!file) return;
    const asset = await upload(file, 'image');
    if (asset) onChange({ [field]: asset });
  };

  const addReference = async (file: File | undefined, kind: InputAssetKind) => {
    if (!file) return;
    const asset = await upload(file, kind);
    if (!asset) return;
    if (kind === 'image') onChange({ referenceImages: [...form.referenceImages, asset] });
    if (kind === 'video') onChange({ referenceVideos: [...form.referenceVideos, asset] });
    if (kind === 'audio') onChange({ referenceAudios: [...form.referenceAudios, asset] });
  };

  if (mode === 'keyframes') {
    return (
      <section className="reference-inputs field-group" aria-label="首尾帧输入">
        <div className="field-heading">
          <span>画面约束</span>
          <span className="subtle-label">PNG · JPEG · WebP</span>
        </div>
        <p className="reference-guidance">首帧确定起始构图；尾帧可选，用于约束镜头最终落点。</p>
        <div className="keyframe-grid">
          <div className={`asset-slot ${form.firstFrame ? 'has-asset' : ''}`}>
            <strong>首帧（必填）</strong>
            {form.firstFrame ? <span title={form.firstFrame.filename}>{assetName(form.firstFrame)}</span> : <small>选择起始画面</small>}
            <label className="asset-upload-button">
              <input
                type="file"
                accept={ACCEPT.image}
                disabled={disabled || uploadCount > 0}
                onChange={(event) => {
                  void chooseKeyframe(event.currentTarget.files?.[0], 'firstFrame');
                  event.currentTarget.value = '';
                }}
              />
              {form.firstFrame ? '替换' : '选择文件'}
            </label>
            {form.firstFrame && <button type="button" className="asset-remove" onClick={() => onChange({ firstFrame: undefined })} disabled={disabled}>移除</button>}
          </div>
          <div className={`asset-slot ${form.lastFrame ? 'has-asset' : ''}`}>
            <strong>尾帧（可选）</strong>
            {form.lastFrame ? <span title={form.lastFrame.filename}>{assetName(form.lastFrame)}</span> : <small>可留空，让模型自由收束</small>}
            <label className="asset-upload-button">
              <input
                type="file"
                accept={ACCEPT.image}
                disabled={disabled || uploadCount > 0}
                onChange={(event) => {
                  void chooseKeyframe(event.currentTarget.files?.[0], 'lastFrame');
                  event.currentTarget.value = '';
                }}
              />
              {form.lastFrame ? '替换' : '选择文件'}
            </label>
            {form.lastFrame && <button type="button" className="asset-remove" onClick={() => onChange({ lastFrame: undefined })} disabled={disabled}>移除</button>}
          </div>
        </div>
        {uploadCount > 0 && <p className="asset-upload-status" role="status">正在上传参考文件…</p>}
        {error && <p className="asset-upload-error" role="alert">{error}</p>}
      </section>
    );
  }

  const groups: Array<{ kind: InputAssetKind; label: string; limit: number; assets: InputAsset[]; patch: (assets: InputAsset[]) => void }> = [
    { kind: 'image', label: '图片参考', limit: 9, assets: form.referenceImages, patch: (referenceImages) => onChange({ referenceImages }) },
    { kind: 'video', label: '视频参考', limit: 3, assets: form.referenceVideos, patch: (referenceVideos) => onChange({ referenceVideos }) },
    { kind: 'audio', label: '音频参考', limit: 3, assets: form.referenceAudios, patch: (referenceAudios) => onChange({ referenceAudios }) },
  ];

  return (
    <section className="reference-inputs field-group" aria-label="多模态参考输入">
      <div className="field-heading">
        <span>多模态参考</span>
        <span className="subtle-label">Ref2VA · 至少一项</span>
      </div>
      <p className="reference-guidance"><span>引用 &lt;Picture 1&gt;、&lt;Video 1&gt;、&lt;Audio 1&gt;</span> 以对应上传顺序写入提示词。</p>
      <div className="reference-groups">
        {groups.map((group) => (
          <div className="reference-group" key={group.kind}>
            <div className="reference-group-heading">
              <strong>{group.label}</strong>
              <span>{group.assets.length} / {group.limit}</span>
            </div>
            {group.assets.length > 0 && (
              <ul className="reference-asset-list">
                {group.assets.map((asset, index) => (
                  <li key={`${asset.filename}-${index}`}>
                    <span title={asset.filename}>{assetName(asset)}</span>
                    <button
                      type="button"
                      aria-label={`移除${group.label} ${index + 1}`}
                      disabled={disabled || uploadCount > 0}
                      onClick={() => group.patch(group.assets.filter((_, itemIndex) => itemIndex !== index))}
                    >×</button>
                  </li>
                ))}
              </ul>
            )}
            <label className="asset-upload-button reference-upload-button">
              <input
                type="file"
                accept={ACCEPT[group.kind]}
                disabled={disabled || uploadCount > 0 || group.assets.length >= group.limit}
                onChange={(event) => {
                  void addReference(event.currentTarget.files?.[0], group.kind);
                  event.currentTarget.value = '';
                }}
              />
              添加{group.label}
            </label>
          </div>
        ))}
      </div>
      <label className="reference-size-select" htmlFor="reference-image-size">
        <span>参考图像尺寸</span>
        <select
          id="reference-image-size"
          value={form.referenceImageSize}
          disabled={disabled || uploadCount > 0}
          onChange={(event) => onChange({ referenceImageSize: event.target.value as GenerationForm['referenceImageSize'] })}
        >
          <option value="match">匹配输出尺寸（推荐）</option>
          <option value="max">保留最大参考尺寸</option>
        </select>
      </label>
      {uploadCount > 0 && <p className="asset-upload-status" role="status">正在上传参考文件…</p>}
      {error && <p className="asset-upload-error" role="alert">{error}</p>}
    </section>
  );
}
