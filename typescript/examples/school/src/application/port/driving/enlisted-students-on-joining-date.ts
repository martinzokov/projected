import { defineQuery, z } from "@projected/application";

export const EnlistedStudentsOnJoiningDate = defineQuery({
  type: "enlisted-students-on-joining-date",
  summary: "Students who joined on a given date and are still enlisted",
  input: z.object({ date: z.iso.date() }),
  output: z.object({
    students: z.array(z.object({ studentId: z.string(), firstname: z.string(), lastname: z.string() })),
  }),
});
