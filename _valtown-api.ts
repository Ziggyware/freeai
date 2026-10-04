const valAPI = {
  async createVal({ name, code }) {
    return await fetch("https://api.val.town/v1/vals", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("VALTOWN_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, code }),
    }).then((r) => r.json());
  },

  async updateVal({ name, code }) {
    return await fetch(`https://api.val.town/v1/vals/${name}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${Deno.env.get("VALTOWN_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    }).then((r) => r.json());
  },
  async deleteVal(name: string) {
    return await fetch(`https://api.val.town/v1/vals/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${Deno.env.get("VALTOWN_API_KEY")}`,
      },
    }).then((r) => r.json());
  },
};

export const ValAPI = {
  async createVal({ name, code }) {
    return await valAPI.createVal({ name, code });
  },
  async updateVal({ name, code }) {
    return await valAPI.updateVal({ name, code });
  },
  async deleteVal(name: string) {
    return await valAPI.deleteVal(name);
  },
};