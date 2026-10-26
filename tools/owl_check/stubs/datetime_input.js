import {Component, xml} from "@odoo/owl";
export class DateTimeInput extends Component {
    static template = xml`<input class="stub-datetime"/>`;
    static props = ["*"];
}
