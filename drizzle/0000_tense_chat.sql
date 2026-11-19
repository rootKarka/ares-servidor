CREATE TABLE "alerts" (
	"event_id" bigserial PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"sensor" text NOT NULL,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"state" text NOT NULL,
	"value" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "readings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"sensor" text NOT NULL,
	"kind" text NOT NULL,
	"value" double precision NOT NULL,
	"level" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "robots" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"on_mission" boolean DEFAULT false NOT NULL,
	"last_status" jsonb,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensors" (
	"robot_id" text NOT NULL,
	"sensor" text NOT NULL,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"warn" double precision NOT NULL,
	"crit" double precision NOT NULL,
	CONSTRAINT "sensors_robot_id_sensor_pk" PRIMARY KEY("robot_id","sensor")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_robot_ts" ON "alerts" USING btree ("robot_id","ts");--> statement-breakpoint
CREATE INDEX "readings_robot_sensor_ts" ON "readings" USING btree ("robot_id","sensor","ts");