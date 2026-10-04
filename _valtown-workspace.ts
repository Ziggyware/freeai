export default {
  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Load workspace from v.storage
    const workspace = (await v.storage.get("workspace")) ?? {
      directories: {},
      files: {},
    };

    // Helpers
    const save = async () => v.storage.set("workspace", workspace);

    // -----------------------------
    // CREATE FILE
    // -----------------------------
    if (path === "/create" && req.method === "POST") {
      const body = await req.json();
      const { filePath, content } = body;

      workspace.files[filePath] = {
        name: filePath.split("/").pop(),
        path: filePath,
        type: "file",
        content,
      };

      await save();
      return new Response("created");
    }

    // -----------------------------
    // UPDATE FILE
    // -----------------------------
    if (path === "/update" && req.method === "POST") {
      const body = await req.json();
      const { filePath, content } = body;

      if (!workspace.files[filePath]) {
        return new Response("not found", { status: 404 });
      }

      workspace.files[filePath].content = content;
      await save();
      return new Response("updated");
    }

    // -----------------------------
    // DELETE FILE
    // -----------------------------
    if (path === "/delete" && req.method === "POST") {
      const body = await req.json();
      const { filePath } = body;

      delete workspace.files[filePath];
      await save();
      return new Response("deleted");
    }

    // -----------------------------
    // LIST FILES
    // -----------------------------
    if (path === "/list") {
      return Response.json(Object.keys(workspace.files));
    }

    // -----------------------------
    // GET FILE
    // -----------------------------
    if (path === "/file") {
      const filePath = url.searchParams.get("path");
      return Response.json(workspace.files[filePath]);
    }

    return new Response("unknown route", { status: 404 });
  },
};