import { Schema } from "effect";

/**
 * Nominal wrapper for scalar types with class syntax.
 * Produces an opaque type that is accepted by Schema constructors
 * (TaggedErrorClass, Class, Struct) when used as a field.
 *
 * @example
 *   class UserID extends Newtype<UserID>()("UserID", Schema.String) {
 *     static random() {
 *       return this.makeUnsafe(crypto.randomUUID());
 *     }
 *   }
 */
export function Newtype<Self>() {
  return <const Tag extends string, S extends Schema.Top>(
    tag: Tag,
    schema: S,
  ) => {
    abstract class Base {
      declare readonly _newtype: Tag;

      static makeUnsafe(value: Schema.Schema.Type<S>): Self {
        return value as unknown as Self;
      }
    }

    Object.setPrototypeOf(Base, schema);

    return Base as unknown as (abstract new (_: never) => {
      readonly _newtype: Tag;
    }) & {
      readonly makeUnsafe: (value: Schema.Schema.Type<S>) => Self;
    } & Omit<Schema.Opaque<Self, S, {}>, "makeUnsafe" | "~type.make"> & {
        readonly "~type.make": Self;
      };
  };
}
