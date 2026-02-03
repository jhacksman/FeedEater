declare module "snoowrap" {
  interface SnoowrapOptions {
    userAgent: string;
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
  }

  interface ConfigOptions {
    requestDelay?: number;
    requestTimeout?: number;
    continueAfterRatelimitError?: boolean;
    warnings?: boolean;
  }

  interface Submission {
    id: string;
    name: string;
    title: string;
    selftext: string;
    url: string;
    author: { name: string } | string;
    subreddit: { display_name: string } | string;
    subreddit_name_prefixed: string;
    score: number;
    num_comments: number;
    created_utc: number;
    over_18: boolean;
    is_self: boolean;
    permalink: string;
    link_flair_text: string | null;
    upvote_ratio: number;
  }

  interface Listing<T> extends Array<T> {
    fetchMore(options: { amount: number }): Promise<Listing<T>>;
    fetchAll(options?: { skipReplies?: boolean }): Promise<Listing<T>>;
    isFinished: boolean;
  }

  export default class Snoowrap {
    constructor(options: SnoowrapOptions);
    config(options: ConfigOptions): void;
    getBest(options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
    getHot(subreddit?: string, options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
    getNew(subreddit?: string, options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
    getSubreddit(subreddit: string): {
      getBest(options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
      getHot(options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
      getNew(options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
    };
    getSubmission(id: string): Promise<Submission>;
    getMe(): {
      getSavedContent(options?: { limit?: number; after?: string }): Promise<Listing<Submission>>;
    };
  }
}
