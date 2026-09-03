interface Music3ComposerProps {
  caption: string;
  lyrics: string;
  onCaptionChange: (value: string) => void;
  onLyricsChange: (value: string) => void;
}

const EXAMPLE_CAPTION = '温暖、克制的电影氛围音乐，钢琴与柔和弦乐缓慢推进，适合清晨咖啡蒸汽的镜头。';

export function Music3Composer({ caption, lyrics, onCaptionChange, onLyricsChange }: Music3ComposerProps) {
  return (
    <section className="field-group music-composer">
      <div className="field-heading">
        <label htmlFor="music-caption">音乐描述 <span>Caption</span></label>
        <span className="character-count">{caption.length} / 4000</span>
      </div>
      <div className="prompt-surface music-caption-surface">
        <textarea
          id="music-caption"
          aria-label="音乐描述 Caption"
          value={caption}
          maxLength={4000}
          rows={4}
          onChange={(event) => onCaptionChange(event.target.value)}
          placeholder="描述曲风、乐器、情绪、速度与编曲走向……"
        />
        {!caption && (
          <button className="prompt-example" type="button" onClick={() => onCaptionChange(EXAMPLE_CAPTION)}>
            <span className="sparkle" aria-hidden="true">✦</span>
            使用示例灵感
          </button>
        )}
      </div>
      <div className="music-lyrics-heading">
        <label htmlFor="music-lyrics">歌词 <span>Lyrics</span></label>
        <small>可选；可使用 [verse]、[chorus] 等段落标签</small>
      </div>
      <textarea
        id="music-lyrics"
        aria-label="歌词 Lyrics"
        className="music-lyrics-input"
        value={lyrics}
        maxLength={8000}
        rows={5}
        onChange={(event) => onLyricsChange(event.target.value)}
        placeholder="[verse]\n清晨的蒸汽慢慢升起"
      />
      <p className="field-hint">Music3 在本机 GB10 上生成并保存 MP3，不会调用第三方音乐服务。</p>
    </section>
  );
}
