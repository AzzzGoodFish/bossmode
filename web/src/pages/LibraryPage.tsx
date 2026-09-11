import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, FileText, Menu, Search } from "lucide-react";
import {
  getKnowledgeEntries,
  getKnowledgeEntry,
  type KnowledgeEntry,
  type KnowledgeEntryInfo,
} from "../api/client";
import { Markdown } from "../components/Markdown";

export function LibraryPage({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [entries, setEntries] = useState<KnowledgeEntryInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<KnowledgeEntry | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    getKnowledgeEntries()
      .then((rows) => {
        if (!stopped) setEntries(rows);
      })
      .catch(() => {
        if (!stopped) setError("文档暂时无法加载，请稍后重试。");
      });
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setDoc(null);
      return;
    }
    let stopped = false;
    setDoc(null);
    setError(null);
    getKnowledgeEntry(selected)
      .then((next) => {
        if (!stopped) setDoc(next);
      })
      .catch(() => {
        if (!stopped) setError("暂时无法打开这份文档。");
      });
    return () => {
      stopped = true;
    };
  }, [selected]);
  const matches = (entries ?? []).filter((entry) =>
    (entry.title + " " + entry.id)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="bm-library-page">
      <header className="bm-chat-header">
        <button
          className="bm-icon-btn bm-mobile-nav"
          aria-label="打开会话导航"
          onClick={onOpenSidebar}
        >
          <Menu size={19} />
        </button>
        <BookOpen size={23} />
        <h1>文档库</h1>
      </header>
      <div className="bm-library-body">
        <aside className={`bm-library-list ${selected ? "has-document" : ""}`}>
          <label className="bm-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文档"
              aria-label="搜索文档"
            />
          </label>
          {matches.slice(0, 200).map((entry) => (
            <button
              key={entry.id}
              className={`bm-library-row ${selected === entry.id ? "is-selected" : ""}`}
              onClick={() => setSelected(entry.id)}
            >
              <FileText size={16} />
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.id}</small>
              </span>
            </button>
          ))}
          {entries && matches.length === 0 && (
            <p className="bm-list-empty">
              {query ? "没有匹配的文档" : "还没有文档"}
            </p>
          )}
          {!entries && !error && <p className="bm-list-empty">正在加载…</p>}
          {matches.length > 200 && (
            <p className="bm-list-empty">
              显示前 200 份文档，可以搜索缩小范围。
            </p>
          )}
        </aside>
        <article className={`bm-library-document ${selected ? "is-open" : ""}`}>
          {selected && (
            <button className="bm-btn" onClick={() => setSelected(null)}>
              <ArrowLeft size={14} />
              返回文档列表
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          {doc ? (
            <>
              <p className="bm-library-path">{doc.id}</p>
              {doc.id.toLowerCase().endsWith(".md") ? (
                <div
                  className="bm-library-markdown"
                  onClick={(event) => {
                    const anchor = (
                      event.target as HTMLElement
                    ).closest<HTMLAnchorElement>("a[href]");
                    const href = anchor?.getAttribute("href");
                    if (
                      !href ||
                      href.startsWith("#") ||
                      href.startsWith("//") ||
                      /^[a-z][a-z0-9+.-]*:/i.test(href)
                    )
                      return;
                    const target = new URL(
                      href,
                      `https://library.invalid/${doc.id}`,
                    );
                    const decode = (value: string) => {
                      try {
                        return decodeURIComponent(value);
                      } catch {
                        return value;
                      }
                    };
                    const direct = decode(href.split("#")[0]);
                    const relative = decode(target.pathname.slice(1));
                    const known = entries?.find(
                      (entry) => entry.id === direct || entry.id === relative,
                    );
                    if (known) {
                      event.preventDefault();
                      setSelected(known.id);
                    }
                  }}
                >
                  <Markdown content={doc.content} />
                </div>
              ) : (
                <>
                  <h2>{doc.title}</h2>
                  <pre className="whitespace-pre-wrap break-words">
                    {doc.content}
                  </pre>
                </>
              )}
            </>
          ) : (
            <p className="bm-list-empty">
              {selected ? !error && "正在读取…" : "选择一份文档查看。"}
            </p>
          )}
        </article>
      </div>
    </section>
  );
}
