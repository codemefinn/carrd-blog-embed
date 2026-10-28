import { markdownToHtml } from "./markdown.js";

(function initCarrdBlog() {
  // ------------------------------------------------------------
  // Configuration
  // Update these IDs to match your Carrd elements.
  // ------------------------------------------------------------
  const script = document.querySelector(
    'script[src*="/carrd-blog-embed@"][type="module"][data-owner][data-repo]',
  );

  if (!script) {
    console.error(
      "Carrd Blog: Unable to find the embed script or its configuration.",
    );
    return;
  }

  const config = {
    owner: script.dataset.owner,
    repo: script.dataset.repo,
    branch: script.dataset.branch || "main",
    postsDirectory: script.dataset.postsDirectory || "posts",
    postsPerPage: Number(script.dataset.postsPerPage) || 6,

    selectors: {
      gallery: script.dataset.gallery || "gallery01",
      title: script.dataset.title || "text01",
      date: script.dataset.date || "text03",
      content: script.dataset.content || "text04",
      pagination: script.dataset.pagination || "icons01",
      articlesSection: script.dataset.articlesSection || "articles",
      articleSection: script.dataset.articleSection || "article",
    },
  };

  const gallery = document.getElementById(config.selectors.gallery);
  const list = gallery?.querySelector("ul");
  const titleElement = document.getElementById(config.selectors.title);
  const dateElement = document.getElementById(config.selectors.date);
  const contentElement = document.getElementById(config.selectors.content);
  const pagination = document.getElementById(config.selectors.pagination);
  const template = list?.querySelector("li")?.cloneNode(true) ?? null;

  let currentPage = 1;
  let allPosts = [];
  let postsPromise = null;
  let articleRequestId = 0;

  const postCache = new Map();
  const postCardCache = new Map();

  const API_URL = `https://api.github.com/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`;
  const RAW_BASE_URL = `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/`;

  // ------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------

  function getPostSlug() {
    return new URL(window.location.href).searchParams.get("slug");
  }

  function formatDate(value) {
    if (!value) return "";

    // Treat YYYY-MM-DD as a UTC date to avoid timezone shifts.
    const date = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
    );

    if (Number.isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  function getArticleUrl(slug) {
    const url = new URL(window.location.href);
    url.searchParams.delete("slug");
    url.searchParams.delete("post");
    url.searchParams.set("slug", slug);
    url.hash = config.selectors.articleSection;
    return url.toString();
  }

  function getSafeImageUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;

    try {
      const url = new URL(value.trim());
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function parseFrontMatter(markdown) {
    const normalized = markdown.replace(/^\uFEFF/, "").trimStart();
    const match = normalized.match(
      /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
    );

    if (!match) {
      throw new Error("Missing or invalid front matter.");
    }

    const metadata = {};
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^(title|slug|date|cover|excerpt):[ \t]*(.*)$/);
      if (!item) continue;

      metadata[item[1]] = item[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }

    return {
      metadata,
      content: normalized.slice(match[0].length).trim(),
    };
  }

  function generateExcerpt(markdown, maxLength = 150) {
    const plainText = markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (plainText.length <= maxLength) return plainText;
    return plainText.slice(0, maxLength).trimEnd() + "...";
  }

  async function fetchMarkdownFile(file) {
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    const rawUrl = `${RAW_BASE_URL}${encodedPath}`;

    const response = await fetch(rawUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${file.path}: HTTP ${response.status}`);
    }

    const markdown = await response.text();
    const { metadata, content } = parseFrontMatter(markdown);

    const fileSlug = file.path
      .slice(`${config.postsDirectory}/`.length)
      .replace(/\.md$/i, "");
    const slug = metadata.slug || fileSlug;

    if (!metadata.title || !slug || !metadata.date) {
      throw new Error(`Missing title, slug, or date in ${file.path}`);
    }

    const post = {
      path: file.path,
      title: metadata.title,
      slug,
      date: metadata.date,
      cover: metadata.cover || "",
      excerpt: metadata.excerpt || generateExcerpt(content),
      content,
    };

    return post;
  }

  // ------------------------------------------------------------
  // postService
  // Reads GitHub Markdown files and caches successful results.
  // ------------------------------------------------------------

  function fetchPosts() {
    if (postsPromise) return postsPromise;

    const postsUrl = `${RAW_BASE_URL}posts.json`;

    postsPromise = (async () => {
      const response = await fetch(postsUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch posts.json: HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error("Invalid posts.json format.");
      }

      const posts = data.filter(
        (post) =>
          post &&
          typeof post.title === "string" &&
          typeof post.slug === "string" &&
          typeof post.date === "string" &&
          typeof post.path === "string" &&
          post.path.startsWith(`${config.postsDirectory}/`) &&
          /\.md$/i.test(post.path),
      );

      posts.sort((a, b) => b.date.localeCompare(a.date));

      allPosts = posts;
      window.carrdBlog = {
        posts,
        errors: [],
        loading: false,
      };

      return posts;
    })().catch((error) => {
      postsPromise = null;
      throw error;
    });

    window.carrdBlog = {
      posts: [],
      errors: [],
      loading: true,
    };

    return postsPromise;
  }

  async function fetchPost(slug) {
    if (!slug) {
      throw new Error("Missing article slug.");
    }

    if (postCache.has(slug)) {
      return postCache.get(slug);
    }

    const posts = await fetchPosts();
    const summary = posts.find((post) => post.slug === slug);

    if (!summary) {
      throw new Error("Article not found.");
    }

    const post = await fetchMarkdownFile({
      path: summary.path,
    });

    if (post.slug !== slug) {
      throw new Error("Article slug does not match posts.json.");
    }

    postCache.set(slug, post);

    return post;
  }

  // ------------------------------------------------------------
  // galleryView
  // ------------------------------------------------------------

  function renderPagination(totalPages) {
    if (!pagination) return;

    const prevLink = pagination.querySelector("a.n01");
    const nextLink = pagination.querySelector("a.n02");

    pagination
      .querySelectorAll("[data-cms-page], [data-cms-ellipsis]")
      .forEach((item) => item.remove());

    const prevItem = prevLink?.closest("li");
    const nextItem = nextLink?.closest("li");

    if (!prevItem || !nextItem) {
      console.warn("[Carrd Blog] Pagination needs .n01 and .n02 links.");
      return;
    }

    const pageCount = Math.max(0, totalPages);

    // Show all pages when there are 5 or fewer.
    let pages = [];

    if (pageCount <= 5) {
      for (let page = 1; page <= pageCount; page++) {
        pages.push(page);
      }
    } else {
      // Always show the first and last pages,
      // plus the current page and its immediate neighbors.
      pages = [
        ...new Set([
          1,
          currentPage - 1,
          currentPage,
          currentPage + 1,
          pageCount,
        ]),
      ]
        .filter((page) => page >= 1 && page <= pageCount)
        .sort((a, b) => a - b);
    }

    const caption = gallery?.querySelector(".caption > p");
    const style = caption ? window.getComputedStyle(caption) : null;

    function insertItem(element, pageNumber) {
      const item = document.createElement("li");
      item.dataset.cmsPage = String(pageNumber);
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.justifyContent = "center";

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(pageNumber);
      button.dataset.page = String(pageNumber);
      button.setAttribute("aria-label", `Page ${pageNumber}`);

      button.style.fontFamily = style?.fontFamily || "inherit";
      button.style.fontSize = style?.fontSize || "inherit";
      button.style.color = style?.color || "inherit";
      button.style.background = "transparent";
      button.style.border = "0";
      button.style.padding = "0 0.35em";
      button.style.cursor = "pointer";
      button.style.display = "inline-flex";
      button.style.alignItems = "center";
      button.style.justifyContent = "center";

      if (pageNumber === currentPage) {
        button.style.fontWeight = "700";
        button.style.textDecoration = "underline";
        button.setAttribute("aria-current", "page");
        button.disabled = true;
        button.style.cursor = "default";
      }

      item.appendChild(button);
      pagination.insertBefore(item, nextItem);
    }

    function insertEllipsis() {
      const item = document.createElement("li");
      item.dataset.cmsEllipsis = "true";
      item.textContent = "…";
      item.setAttribute("aria-hidden", "true");
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.justifyContent = "center";
      item.style.padding = "0 0.2em";

      pagination.insertBefore(item, nextItem);
    }

    let previousPage = 0;

    for (const page of pages) {
      if (previousPage && page - previousPage > 1) {
        insertEllipsis();
      }

      insertItem(page, page);
      previousPage = page;
    }

    const disableArrow = (link, disabled) => {
      link.setAttribute("aria-disabled", String(disabled));
      link.style.opacity = disabled ? "0.35" : "";
      link.style.pointerEvents = disabled ? "none" : "";
    };

    disableArrow(prevLink, currentPage <= 1 || pageCount === 0);
    disableArrow(nextLink, currentPage >= pageCount || pageCount === 0);

    pagination.hidden = pageCount <= 1;
  }

  function initPagination() {
    if (!pagination) return;

    pagination.addEventListener("click", (event) => {
      const link = event.target.closest("a.n01, a.n02");
      const pageButton = event.target.closest("button[data-page]");
      if (!link && !pageButton) return;

      event.preventDefault();

      const totalPages = Math.ceil(allPosts.length / config.postsPerPage);
      if (pageButton) {
        currentPage = Number(pageButton.dataset.page);
      } else if (link.matches(".n01")) {
        currentPage--;
      } else {
        currentPage++;
      }

      currentPage = Math.max(1, Math.min(currentPage, Math.max(totalPages, 1)));
      renderGallery(allPosts);
    });
  }

  function renderGallery(posts) {
    if (!list || !template) return;

    allPosts = posts;
    const totalPages = Math.ceil(allPosts.length / config.postsPerPage);
    currentPage = Math.max(1, Math.min(currentPage, Math.max(totalPages, 1)));

    const startIndex = (currentPage - 1) * config.postsPerPage;
    const visiblePosts = allPosts.slice(
      startIndex,
      startIndex + config.postsPerPage,
    );

    if (!allPosts.length) {
      list.replaceChildren();
      const message = document.createElement("li");
      message.textContent = "No posts found.";
      list.appendChild(message);
      renderPagination(0);
      return;
    }

    const visibleItems = visiblePosts.map((post) => {
      let item = postCardCache.get(post.slug);

      if (!item) {
        item = template.cloneNode(true);
        const cardLink = item.querySelector("a");
        const image = item.querySelector("img");
        const frame = item.querySelector(".frame");
        const caption = item.querySelector(".caption");
        const articleUrl = getArticleUrl(post.slug);

        if (cardLink) cardLink.href = articleUrl;

        const coverUrl = getSafeImageUrl(post.cover);
        if (coverUrl && image) {
          image.src = coverUrl;
          image.alt = post.title || "";
          image.hidden = false;
          if (frame) frame.hidden = false;
        } else {
          image?.remove();
          frame?.remove();
        }

        if (caption) {
          const heading = document.createElement("strong");
          heading.textContent = post.title || "Untitled";
          let titleNode = heading;

          if (!cardLink || !cardLink.contains(caption)) {
            const titleLink = document.createElement("a");
            titleLink.href = articleUrl;
            titleLink.appendChild(heading);
            titleNode = titleLink;
          }

          const date = document.createElement("span");
          date.style.color = "#555555";
          date.style.display = "inline-block";
          date.textContent = formatDate(post.date);

          const excerpt = document.createElement("span");
          excerpt.innerHTML = markdownToHtml(post.excerpt || "");

          const paragraph = caption.querySelector("p");
          if (paragraph) {
            paragraph.replaceChildren(
              titleNode,
              document.createElement("br"),
              date,
              document.createElement("br"),
              excerpt,
            );
          }
        }

        postCardCache.set(post.slug, item);
      }

      return item;
    });

    list.replaceChildren(...visibleItems);
    renderPagination(totalPages);
  }

  // ------------------------------------------------------------
  // articleView
  // ------------------------------------------------------------

  function renderArticle(post) {
    if (!post) {
      if (titleElement) titleElement.textContent = "Article not found.";
      if (dateElement) dateElement.textContent = "";
      if (contentElement) contentElement.textContent = "";
      return;
    }

    if (titleElement) titleElement.textContent = post.title || "Untitled";
    if (dateElement) dateElement.textContent = formatDate(post.date);

    if (contentElement) {
      contentElement.innerHTML = markdownToHtml(post.content || "");
    }
  }

  function renderArticleError(error) {
    console.error("[Carrd Blog] Unable to load article:", error);
    if (titleElement) titleElement.textContent = "Unable to load article.";
    if (dateElement) dateElement.textContent = "";
    if (contentElement) {
      contentElement.textContent =
        "Please check your website connection and try again.";
    }
  }

  async function loadCurrentGallery() {
    if (!list || !template) return;
    try {
      const posts = await fetchPosts();
      currentPage = 1;
      renderGallery(posts);
    } catch (error) {
      console.error("[Carrd Blog] Unable to load posts:", error);
      list.replaceChildren();
      const message = document.createElement("li");
      message.textContent =
        "Unable to load posts. Please check your website connection.";
      list.appendChild(message);
    }
  }

  async function loadCurrentArticle(slug) {
    const requestId = ++articleRequestId;
    if (titleElement) titleElement.textContent = "Loading article...";
    if (dateElement) dateElement.textContent = "";
    if (contentElement) contentElement.replaceChildren();

    try {
      const post = await fetchPost(slug);
      if (requestId !== articleRequestId) return;
      renderArticle(post);
    } catch (error) {
      if (requestId !== articleRequestId) return;
      renderArticleError(error);
    }
  }

  function initArticleNavigation() {
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;

      const url = new URL(link.href, window.location.href);

      if (
        url.origin !== window.location.origin ||
        !url.searchParams.has("slug") ||
        url.hash !== `#${config.selectors.articleSection}`
      ) {
        return;
      }

      event.preventDefault();

      const slug = url.searchParams.get("slug");

      history.pushState(
        {
          ...history.state,
          cmsArticleSlug: slug,
        },
        "",
        url,
      );

      window.dispatchEvent(new HashChangeEvent("hashchange"));
      loadCurrentArticle(slug);
    });

    window.addEventListener("popstate", () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));

      const url = new URL(window.location.href);
      let slug = url.searchParams.get("slug");

      if (window.location.hash === `#${config.selectors.articleSection}`) {
        // Restore the slug if it was removed during section navigation.
        if (!slug && history.state?.cmsArticleSlug) {
          slug = history.state.cmsArticleSlug;

          url.searchParams.set("slug", slug);
          history.replaceState(history.state, "", url);
        }

        if (slug) {
          loadCurrentArticle(slug);
        }
      } else if (
        window.location.hash === `#${config.selectors.articlesSection}`
      ) {
        loadCurrentGallery();
      }
    });
  }

  function initSectionNavigation() {
    document.addEventListener(
      "click",
      (event) => {
        const link = event.target.closest("a[href]");
        if (!link) return;

        const rawHref = link.getAttribute("href");
        if (!rawHref || !rawHref.startsWith("#")) return;

        if (rawHref === `#${config.selectors.articleSection}`) return;

        const url = new URL(window.location.href);
        const slug = url.searchParams.get("slug");

        if (slug || url.searchParams.has("post")) {
          // Preserve the article slug in this history entry.
          history.replaceState(
            {
              ...history.state,
              cmsArticleSlug: slug,
            },
            "",
            window.location.href,
          );

          // Remove CMS parameters without removing unrelated parameters.
          url.searchParams.delete("slug");
          url.searchParams.delete("post");

          history.replaceState(history.state, "", url);
        }

        if (rawHref === `#${config.selectors.articlesSection}`) {
          loadCurrentGallery();
        }
      },
      true,
    );
  }

  async function init() {
    initSectionNavigation();
    initArticleNavigation();
    initPagination();

    const slug = getPostSlug();

    if (
      slug &&
      window.location.hash === `#${config.selectors.articleSection}`
    ) {
      await loadCurrentArticle(slug);
      return;
    }

    if (!list || !template) {
      console.error(
        "[Carrd Blog] Gallery template not found. Check the gallery ID and make sure it has at least one list item.",
      );
      return;
    }

    await loadCurrentGallery();
  }

  init();
})();
