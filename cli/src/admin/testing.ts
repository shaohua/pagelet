import type { AdminDepsOverrides, FetchFn } from "./deps.js";
import type { GcloudRunner } from "./gcloud.js";
import type { AdminIo } from "./io.js";

export type GcloudCall = {
  args: string[];
  stdin?: string;
};

export type GcloudReply = {
  code?: number;
  stdout?: string;
  stderr?: string;
};

/** `replies` answers repeated calls in order; the last one keeps answering. */
export type GcloudRoute = {
  when: string;
  reply?: GcloudReply;
  replies?: GcloudReply[];
};

export type FakeGcloud = {
  runner: GcloudRunner;
  calls: GcloudCall[];
  mutations(): GcloudCall[];
  find(fragment: string): GcloudCall | undefined;
  call(fragment: string): GcloudCall;
};

/**
 * Anything that could change the project. Tests use it to prove that dry runs
 * and declined confirmations only ever read.
 */
const MUTATING = /\b(create|deploy|delete|enable|update|add|rm)\b/;

export function createFakeGcloud(routes: GcloudRoute[] = []): FakeGcloud {
  const calls: GcloudCall[] = [];
  const seen = new Map<GcloudRoute, number>();
  const runner: GcloudRunner = (args, stdin) => {
    calls.push({ args, stdin });

    const line = args.join(" ");
    // Longest match wins, so a specific route beats a general one whatever the
    // order they were declared in. Ties go to the last declaration, which lets
    // a test override one route of a shared set.
    const [route] = [...routes]
      .reverse()
      .filter((candidate) => line.includes(candidate.when))
      .sort((left, right) => right.when.length - left.when.length);

    if (!route) {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }

    const index = seen.get(route) ?? 0;
    seen.set(route, index + 1);

    const reply =
      route.replies && route.replies.length > 0
        ? route.replies[Math.min(index, route.replies.length - 1)]
        : route.reply;

    return Promise.resolve({
      code: reply?.code ?? 0,
      stdout: reply?.stdout ?? "",
      stderr: reply?.stderr ?? ""
    });
  };

  return {
    runner,
    calls,
    mutations: () => calls.filter((call) => MUTATING.test(call.args.join(" "))),
    find: (fragment) => calls.find((call) => call.args.join(" ").includes(fragment)),
    call(fragment) {
      const found = calls.find((call) => call.args.join(" ").includes(fragment));

      if (!found) {
        throw new Error(
          [
            `No gcloud call matching: ${fragment}`,
            ...calls.map((call) => `  gcloud ${call.args.join(" ")}`)
          ].join("\n")
        );
      }

      return found;
    }
  };
}

export function flagValue(call: GcloudCall, flag: string): string {
  const index = call.args.indexOf(flag);
  return index < 0 ? "" : call.args[index + 1] ?? "";
}

export type FakeIo = {
  io: AdminIo;
  lines: string[];
  errors: string[];
  prompts: string[];
  text(): string;
};

export function createFakeIo(
  options: {
    answers?: string[];
    confirms?: boolean[];
    interactive?: boolean;
  } = {}
): FakeIo {
  const answers = [...(options.answers ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const lines: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const answer = (question: string): Promise<string> => {
    prompts.push(question);
    const next = answers.shift();

    if (next === undefined) {
      throw new Error(`Unexpected prompt: ${question}`);
    }

    return Promise.resolve(next);
  };

  return {
    lines,
    errors,
    prompts,
    text: () => [...lines, ...errors].join("\n"),
    io: {
      out: (text) => {
        lines.push(text);
      },
      err: (text) => {
        errors.push(text);
      },
      prompt: answer,
      promptSecret: answer,
      confirm: (question) => {
        prompts.push(question);
        const next = confirms.shift();

        if (next === undefined) {
          throw new Error(`Unexpected confirmation: ${question}`);
        }

        return Promise.resolve(next);
      },
      isInteractive: options.interactive ?? true
    }
  };
}

export type FetchRoute = {
  when: string;
  status: number;
  headers?: Record<string, string>;
};

export function createFakeFetch(routes: FetchRoute[] = []): {
  fetch: FetchFn;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchFn: FetchFn = (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    urls.push(url);

    const [route] = [...routes]
      .reverse()
      .filter((candidate) => url.includes(candidate.when))
      .sort((left, right) => right.when.length - left.when.length);

    return Promise.resolve(
      new Response(null, {
        status: route?.status ?? 200,
        headers: route?.headers
      })
    );
  };

  return { fetch: fetchFn, urls };
}

export type FakeAdmin = {
  deps: AdminDepsOverrides;
  gcloud: FakeGcloud;
  io: FakeIo;
  logins: string[];
};

export function createFakeAdmin(
  options: {
    gcloud?: GcloudRoute[];
    fetch?: FetchRoute[];
    answers?: string[];
    confirms?: boolean[];
    interactive?: boolean;
    loginFails?: boolean;
  } = {}
): FakeAdmin {
  const gcloud = createFakeGcloud(options.gcloud);
  const io = createFakeIo(options);
  const fetcher = createFakeFetch(options.fetch);
  const logins: string[] = [];

  return {
    gcloud,
    io,
    logins,
    deps: {
      gcloud: gcloud.runner,
      io: io.io,
      fetch: fetcher.fetch,
      sleep: () => Promise.resolve(),
      deviceLogin: (apiBaseUrl) => {
        logins.push(apiBaseUrl);

        return options.loginFails
          ? Promise.reject(new Error("login refused"))
          : Promise.resolve({
              email: "dev@example.com",
              configPath: "/tmp/pagelet-test-config.json"
            });
      }
    }
  };
}

export function runServiceJson(input: {
  url: string;
  image?: string;
  managed?: boolean;
  env?: Record<string, string>;
}): string {
  return JSON.stringify({
    metadata: {
      labels: input.managed === false ? {} : { "pagelet-managed": "true" }
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              image: input.image ?? "us-central1-docker.pkg.dev/p/pagelet-upstream/shaohua/pagelet:0.1.0",
              env: Object.entries(input.env ?? {}).map(([name, value]) => ({
                name,
                value
              }))
            }
          ]
        }
      }
    },
    status: { url: input.url }
  });
}

export function managedLabels(): string {
  return JSON.stringify({ labels: { "pagelet-managed": "true" } });
}
